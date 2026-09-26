'use strict';

const mongoose = require('mongoose');
const Counter = require('../models/Counter');
const Ledger = require('../models/Ledger');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const SubAccount = require('../models/SubAccount');
const Notification = require('../models/Notification');
const { resolveAccountByCode } = require('./accountCodeService');
const { createBalanceTransferReceiptProof } = require('./balanceTransferReceiptService');
const { logAction } = require('./auditService');
const {
    resolveStampTenant,
    assertAccountsSameTenant,
    beginIdempotentFinancialRequest,
    acquireWalletLock,
    tenantStamp
} = require('./financialSafety');
const {
    isMongoTransactionFallbackError,
    requiresMongoTransactions,
    financialTransactionsUnavailableError
} = require('./walletService');

const modelByName = {
    User,
    ClientCompany,
    SubAccount
};

const canUseMongoTransactions = async () => {
    try {
        if (!mongoose.connection.db) return false;
        const info = await mongoose.connection.db.admin().command({ replSetGetStatus: 1 }).catch(() => null);
        return Boolean(info);
    } catch (_) {
        return false;
    }
};

const nextBalanceTransferId = async (session) => {
    const counter = await Counter.findOneAndUpdate(
        { name: 'balance_transfer' },
        { $inc: { value: 1 } },
        { upsert: true, new: true, ...(session ? { session } : {}) }
    );
    const yy = new Date().getFullYear().toString().slice(-2);
    const mm = String(new Date().getMonth() + 1).padStart(2, '0');
    return `BTR-${yy}${mm}-${String(counter.value).padStart(4, '0')}`;
};

const accountName = (account) => account.doc.name || account.doc.webUsername || account.doc.phone || account.modelName;

const isActiveAccount = (account) => {
    if (!account?.doc) return false;
    return account.doc.status === 'active';
};

const assertDifferentAccounts = (source, target) => {
    if (source.modelName === target.modelName && String(source.doc._id) === String(target.doc._id)) {
        throw new Error('SAME_ACCOUNT');
    }
};

const buildEntityTransactionFields = async (account, customId, status, amount, notes, adminNotes, session) => {
    const base = {
        customId,
        transferType: 'balance_transfer',
        vodafoneNumber: account.doc.accountCode || 'BALANCE',
        accountNumber: account.doc.accountCode || '',
        accountName: accountName(account),
        amount,
        costLYD: 0,
        status,
        notes,
        customerNotes: notes,
        adminNotes
    };

    if (account.modelName === 'User') {
        return {
            ...base,
            userId: account.doc.phone || account.doc.webUsername,
            companyId: null,
            subAccountId: null,
            companyName: account.doc.role === 'agent' ? 'وكيل فردي' : 'عميل فردي',
            employeeName: account.doc.name
        };
    }

    if (account.modelName === 'ClientCompany') {
        return {
            ...base,
            userId: 'balance-transfer',
            companyId: account.doc._id,
            subAccountId: null,
            companyName: account.doc.name,
            employeeName: account.performedBy || account.doc.name
        };
    }

    const masterModel = account.doc.masterType === 'company' ? ClientCompany : User;
    const master = await masterModel.findById(account.doc.masterId).session(session || null);

    return {
        ...base,
        userId: account.doc.masterType === 'user' && master ? (master.phone || master.webUsername) : null,
        companyId: account.doc.masterType === 'company' && master ? master._id : null,
        subAccountId: account.doc._id,
        isSubAccountTx: true,
        companyName: master ? master.name : 'وكيل غير معروف',
        subAccountName: account.doc.name,
        employeeName: account.doc.name
    };
};

const createLedgerEntries = (source, target, transferId, amount, sourceAfter, targetAfter, tenantId) => ([
    {
        ...tenantStamp(tenantId),
        entityId: source.doc._id,
        entityModel: source.modelName,
        transactionId: transferId,
        type: 'TRANSFER',
        amount: -amount,
        balanceBefore: sourceAfter.balance + amount,
        balanceAfter: sourceAfter.balance,
        description: `تحويل رصيد إلى ${accountName(target)} (${target.doc.accountCode})`
    },
    {
        ...tenantStamp(tenantId),
        entityId: target.doc._id,
        entityModel: target.modelName,
        transactionId: transferId,
        type: 'TRANSFER',
        amount,
        balanceBefore: targetAfter.balance - amount,
        balanceAfter: targetAfter.balance,
        description: `استلام رصيد من ${accountName(source)} (${source.doc.accountCode || 'بدون ID'})`
    }
]);

const notifyAccount = async (account, title, message, type = 'transfer') => {
    try {
        if (account.modelName === 'User') {
            const userId = account.doc.phone || account.doc.webUsername;
            if (userId) await Notification.create({ userId, title, message, type });
            return;
        }

        if (account.modelName === 'SubAccount') {
            await Notification.create({ userId: account.doc.webUsername, title, message, type });
            return;
        }

        const employees = await ClientEmployee.find({ companyId: account.doc._id, status: 'active' }).select('webUsername').lean();
        await Promise.all(employees.map((emp) => Notification.create({ userId: emp.webUsername, title, message, type }).catch(() => {})));
    } catch (_) {}
};

const executeBalanceTransfer = async ({
    source,
    targetCode,
    amount,
    notes = '',
    idempotencyKey = null,
    idempotencyFingerprint = null,
    idempotencyLockHeld = false,
    idempotencyChannel = 'balance-transfer',
    idempotencyPayload = null,
    tenantContext = null,
    req = null,
    session: externalSession = null
}) => {
    const normalizedAmount = Number(amount);
    if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
        throw new Error('INVALID_AMOUNT');
    }

    const request = tenantContext || req;
    const tenantId = resolveStampTenant({ req: request, account: source && source.doc });
    const target = await resolveAccountByCode(targetCode, request);
    if (!target) throw new Error('TARGET_NOT_FOUND');
    if (!isActiveAccount(source)) throw new Error('SOURCE_INACTIVE');
    if (!isActiveAccount(target)) throw new Error('TARGET_INACTIVE');
    assertDifferentAccounts(source, target);
    assertAccountsSameTenant(source.doc.tenantId, target.doc.tenantId);

    let idempotency = { active: false, release: async () => {}, key: null, fingerprint: null, replay: null };
    if (!idempotencyLockHeld) {
        idempotency = await beginIdempotentFinancialRequest({
            key: idempotencyKey,
            accountId: source.doc._id,
            tenantId,
            channel: idempotencyChannel,
            payload: idempotencyPayload || {
                targetAccountCode: String(targetCode || ''),
                amount: normalizedAmount,
                notes: String(notes || '')
            },
            fingerprint: idempotencyFingerprint
        });
        if (idempotency.replay) {
            return { replayed: true, ...idempotency.replay, clientResponse: idempotency.replay };
        }
    }

    let walletLock = { release: async () => {} };
    try {
        walletLock = await acquireWalletLock(source.doc._id);
    } catch (error) {
        await idempotency.release();
        throw error;
    }

    const SourceModel = modelByName[source.modelName];
    const TargetModel = modelByName[target.modelName];
    const description = notes ? notes.trim() : '';
    const sourceAdminNotes = `تحويل رصيد صادر إلى ${accountName(target)} - ID: ${target.doc.accountCode || 'غير محدد'}`;
    const targetAdminNotes = `تحويل رصيد وارد من ${accountName(source)} - ID: ${source.doc.accountCode || 'غير محدد'}`;

    let useTransaction = false;
    let session = externalSession || null;
    let sourceAfter;
    let targetAfter;
    let transferId;
    let auditRelease = null;

    try {
        if (!externalSession) {
            useTransaction = await canUseMongoTransactions();
            if (!useTransaction && requiresMongoTransactions()) {
                throw financialTransactionsUnavailableError(
                    new Error('MongoDB replica set or sharded cluster is unavailable')
                );
            }
            if (useTransaction) {
                try {
                    session = await mongoose.startSession();
                    session.startTransaction();
                } catch (error) {
                    if (requiresMongoTransactions()) {
                        throw financialTransactionsUnavailableError(error);
                    }
                    useTransaction = false;
                    session = null;
                }
            }
        }

        transferId = await nextBalanceTransferId(session);
        const options = session ? { session, ordered: true } : {};
        sourceAfter = await SourceModel.findOneAndUpdate(
            { _id: source.doc._id, balance: { $gte: normalizedAmount } },
            { $inc: { balance: -normalizedAmount } },
            { new: true, ...options }
        );
        if (!sourceAfter) throw new Error('INSUFFICIENT_BALANCE');

        targetAfter = await TargetModel.findByIdAndUpdate(
            target.doc._id,
            { $inc: { balance: normalizedAmount } },
            { new: true, ...options }
        );
        if (!targetAfter) throw new Error('TARGET_NOT_FOUND');

        const receiptProofId = createBalanceTransferReceiptProof({
            transferId,
            sourceName: accountName(source),
            sourceCode: source.doc.accountCode || '',
            targetName: accountName(target),
            targetCode: target.doc.accountCode || '',
            amount: normalizedAmount,
            sourceBalanceBefore: sourceAfter.balance + normalizedAmount,
            sourceBalanceAfter: sourceAfter.balance,
            targetBalanceBefore: targetAfter.balance - normalizedAmount,
            targetBalanceAfter: targetAfter.balance,
            notes: description,
            createdAt: new Date()
        });

        const storedKey = idempotency.key || idempotencyKey || null;
        const storedFingerprint = idempotency.fingerprint || idempotencyFingerprint || null;
        const clientResponse = {
            success: true,
            message: `تم تحويل ${normalizedAmount.toFixed(2)} LYD إلى ${accountName(target)} بنجاح.`,
            transferId,
            newBalance: sourceAfter.balance.toFixed(2),
            amount: normalizedAmount,
            sourceBalance: sourceAfter.balance,
            targetName: accountName(target),
            targetCode: target.doc.accountCode,
            targetType: target.label
        };
        const sourceTx = await buildEntityTransactionFields(source, `${transferId}-D`, 'deduction', normalizedAmount, description, sourceAdminNotes, session);
        sourceTx.proofImage = receiptProofId;
        sourceTx.proofImages = [receiptProofId];
        Object.assign(sourceTx, tenantStamp(tenantId));
        if (storedKey) {
            sourceTx.idempotencyKey = storedKey;
            sourceTx.idempotencyFingerprint = storedFingerprint;
            sourceTx.idempotencyResponse = clientResponse;
        }
        const targetTx = await buildEntityTransactionFields(target, `${transferId}-C`, 'deposit', normalizedAmount, description, targetAdminNotes, session);
        targetTx.proofImage = receiptProofId;
        targetTx.proofImages = [receiptProofId];
        Object.assign(targetTx, tenantStamp(tenantId));
        await Transaction.create([sourceTx, targetTx], options);

        const ledgerEntries = createLedgerEntries(source, target, transferId, normalizedAmount, sourceAfter, targetAfter, tenantId);
        await Ledger.create(ledgerEntries, options);

        const auditHold = await logAction({
            action: 'TRANSFER_CREATED',
            req: request,
            performedById: source.doc._id,
            performedByModel: source.modelName,
            performedByName: source.doc.name,
            newData: { customId: transferId, amount: normalizedAmount, transferType: 'balance_transfer' },
            metadata: { targetName: accountName(target), targetCode: target.doc.accountCode },
            tenantId,
            session,
            holdLock: Boolean(session && !externalSession),
            required: Boolean(session && !externalSession)
        });
        auditRelease = auditHold && auditHold.release;

        if (session && !externalSession) {
            await session.commitTransaction();
            session.endSession();
            session = null;
        }
        if (auditRelease) {
            await auditRelease();
            auditRelease = null;
        }

        notifyAccount(source, 'تحويل رصيد صادر', `تم تحويل ${normalizedAmount.toFixed(2)} LYD إلى ${accountName(target)}. رقم العملية: ${transferId}`, 'deduction').catch(() => {});
        notifyAccount(target, 'تحويل رصيد وارد', `تم استلام ${normalizedAmount.toFixed(2)} LYD من ${accountName(source)}. رقم العملية: ${transferId}`, 'deposit').catch(() => {});

        return {
            replayed: false,
            success: true,
            clientResponse,
            transferId,
            amount: normalizedAmount,
            sourceBalance: sourceAfter.balance,
            targetName: accountName(target),
            targetCode: target.doc.accountCode,
            targetType: target.label
        };
    } catch (error) {
        if (auditRelease) {
            await auditRelease().catch(() => {});
            auditRelease = null;
        }
        if (session && !externalSession) {
            try {
                await session.abortTransaction();
                session.endSession();
            } catch (_) {}
        } else if (!session && sourceAfter && !requiresMongoTransactions()) {
            await SourceModel.findByIdAndUpdate(source.doc._id, { $inc: { balance: normalizedAmount } }).catch(() => {});
            if (targetAfter) {
                await TargetModel.findByIdAndUpdate(target.doc._id, { $inc: { balance: -normalizedAmount } }).catch(() => {});
            }
            await Transaction.deleteMany({ customId: { $in: [`${transferId}-D`, `${transferId}-C`] } }).catch(() => {});
            await Ledger.deleteMany({ transactionId: transferId }).catch(() => {});
        }
        if (requiresMongoTransactions() && (isMongoTransactionFallbackError(error) || (!session && sourceAfter))) {
            throw financialTransactionsUnavailableError(error);
        }
        throw error;
    } finally {
        await walletLock.release();
        await idempotency.release();
    }
};

module.exports = { executeBalanceTransfer };
