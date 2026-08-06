// services/mobileWebParityService.js
'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const Transaction = require('../models/Transaction');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const ClientCompany = require('../models/ClientCompany');
const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const SubAccount = require('../models/SubAccount');
const AgentEmployee = require('../models/AgentEmployee');
const SupportTicket = require('../models/SupportTicket');
const Admin = require('../models/Admin');
const Counter = require('../models/Counter');

const { executeBalanceTransfer } = require('./balanceTransferService');
const { resolveAccountByCode, normalizeAccountCode } = require('./accountCodeService');
const { logAction } = require('./auditService');
const { acquireLock, releaseLock } = require('./lockService');

const appendNoteText = (current, note) => {
    const cleanNote = String(note || '').trim();
    if (!cleanNote) return current || '';
    return current ? `${current}\n${cleanNote}` : cleanNote;
};

const appendAdminNote = (tx, note) => {
    tx.adminNotes = appendNoteText(tx.adminNotes, note);
};

const appendCustomerReference = (tx, label, value) => {
    const cleanValue = String(value || '').trim();
    if (!cleanValue) return;
    const line = `[${label}: ${cleanValue}]`;
    if (!String(tx.notes || '').includes(line)) {
        tx.notes = appendNoteText(tx.notes, line);
    }
};

// Helper to get start/end dates
function getDateRange(dateStr, monthStr) {
    if (dateStr) {
        const start = new Date(dateStr); start.setHours(0, 0, 0, 0);
        const end = new Date(dateStr); end.setHours(23, 59, 59, 999);
        return { start, end };
    } else if (monthStr) {
        const [year, month] = monthStr.split('-');
        const start = new Date(year, parseInt(month) - 1, 1);
        const end = new Date(year, parseInt(month), 0, 23, 59, 59, 999);
        return { start, end };
    }
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1); start.setHours(0, 0, 0, 0);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0); end.setHours(23, 59, 59, 999);
    return { start, end };
}

// Generate server-side request fingerprint
function buildIdempotencyFingerprint(req) {
    const method = req.method;
    const path = (req.baseUrl || '') + req.path;
    const userOrAccount = req.user ? (req.user.userId || 'anonymous') : 'anonymous';
    
    const sortedBody = {};
    if (req.body && typeof req.body === 'object') {
        Object.keys(req.body).sort().forEach(key => {
            sortedBody[key] = req.body[key];
        });
    }
    
    const payload = {
        method,
        path,
        userOrAccount,
        body: sortedBody
    };
    
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

const sameId = (left, right) => String(left || '') === String(right || '');

const numberOrNull = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
};

const assertPositiveRate = (value) => {
    const parsed = numberOrNull(value);
    if (!parsed || parsed <= 0) {
        throw new Error('INVALID_RATE');
    }
    return parsed;
};

const assertGroupOwnsTask = (tx, groupId) => {
    const ownsExecutorGroup = tx.executorGroupId && sameId(tx.executorGroupId, groupId);
    const ownsManagerGroup = tx.managerGroupId && sameId(tx.managerGroupId, groupId);
    if (!ownsExecutorGroup && !ownsManagerGroup) {
        throw new Error('FORBIDDEN');
    }
};

const nextDepositRequestId = async (session) => {
    const counter = await Counter.findOneAndUpdate(
        { name: 'deposit_request' },
        { $inc: { value: 1 } },
        { upsert: true, new: true, ...(session ? { session } : {}) }
    );
    const yy = new Date().getFullYear().toString().slice(-2);
    const mm = String(new Date().getMonth() + 1).padStart(2, '0');
    return `DEPREQ-${yy}${mm}-${String(counter.value).padStart(4, '0')}`;
};

const updateBalanceWithCreditLimit = async ({ Model, id, diff, session }) => {
    if (!Number.isFinite(diff) || diff === 0) return null;

    const current = await Model.findById(id).session(session);
    if (!current) throw new Error('ACCOUNT_NOT_FOUND');

    if (diff > 0) {
        const minBalance = diff - (current.creditLimit || 0);
        const updated = await Model.findOneAndUpdate(
            { _id: id, balance: { $gte: minBalance } },
            { $inc: { balance: -diff } },
            { new: true, session }
        );
        if (!updated) throw new Error('INSUFFICIENT_BALANCE');
        return updated;
    }

    return await Model.findByIdAndUpdate(
        id,
        { $inc: { balance: Math.abs(diff) } },
        { new: true, session }
    );
};

const parseSupportImage = (imageBase64) => {
    if (!imageBase64) return null;
    if (typeof imageBase64 !== 'string') throw new Error('INVALID_IMAGE');

    const match = imageBase64.match(/^data:image\/(jpeg|jpg|png|webp);base64,/i);
    if (!match) throw new Error('INVALID_IMAGE');

    const base64Data = imageBase64.replace(/^data:image\/(jpeg|jpg|png|webp);base64,/i, '');
    if (base64Data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(base64Data)) {
        throw new Error('INVALID_IMAGE');
    }

    const buffer = Buffer.from(base64Data, 'base64');
    if (buffer.length > 4 * 1024 * 1024) {
        throw new Error('IMAGE_TOO_LARGE');
    }

    const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
    return { buffer, ext };
};

/**
 * 📊 Client Reports Parity
 */
async function getClientReports({ userId, accountType, dateType, dateValue, tenantId }) {
    let account = null;
    let company = null;
    const isEmployee = accountType === 'client_company';
    const isAgentStaff = accountType === 'agent_staff';
    const isSubAccount = accountType === 'sub_client';

    if (isEmployee) {
        account = await ClientEmployee.findById(userId);
        if (!account) throw new Error('UNAUTHORIZED');
        company = await ClientCompany.findById(account.companyId);
    } else if (isAgentStaff) {
        account = await AgentEmployee.findById(userId);
        if (!account) throw new Error('UNAUTHORIZED');
        company = await User.findById(account.agentId);
        if (!company || company.role !== 'agent') throw new Error('UNAUTHORIZED');
    } else if (isSubAccount) {
        account = await SubAccount.findById(userId);
        if (!account) throw new Error('UNAUTHORIZED');
    } else {
        account = await User.findById(userId);
        if (!account) throw new Error('UNAUTHORIZED');
    }

    let { start, end } = getDateRange(
        dateType === 'day' ? dateValue : null,
        dateType === 'month' ? dateValue : null
    );

    const canViewAll = (!isEmployee && !isAgentStaff)
        || account.canViewAllReports
        || account.canManageAgent
        || account.role === 'accountant';

    if ((isEmployee || isAgentStaff) && !canViewAll) {
        const today = new Date();
        start = new Date(today.setHours(0, 0, 0, 0));
        end = new Date(today.setHours(23, 59, 59, 999));
    }

    let baseQuery = {};
    if (tenantId) baseQuery.tenantId = tenantId;

    if (isEmployee) {
        baseQuery.companyId = account.companyId;
    } else if (isAgentStaff) {
        const subAccountIds = await SubAccount
            .find({ masterType: 'user', masterId: company._id, status: { $ne: 'deleted' } })
            .distinct('_id');
        baseQuery.$or = [
            { userId: company.phone, companyId: null },
            { userId: company.webUsername, companyId: null },
            { subAccountId: { $in: subAccountIds } }
        ].filter((cond) => {
            const value = cond.userId || cond.subAccountId;
            return value !== undefined && value !== null;
        });
    } else if (isSubAccount) {
        baseQuery.subAccountId = account._id;
        baseQuery.isSubAccountTx = true;
    } else {
        baseQuery.$or = [
            { userId: account.phone },
            { userId: account.webUsername },
            { employeeName: account.name, companyName: { $regex: /عميل فردي/ } }
        ];
        baseQuery.$or = baseQuery.$or.filter(cond => {
            const val = Object.values(cond)[0];
            return val !== undefined && val !== null;
        });
        baseQuery.companyId = null;
        baseQuery.isSubAccountTx = { $ne: true };
    }

    const prevTransactions = await Transaction.find({ ...baseQuery, createdAt: { $lt: start } }).select('status amount costLYD').lean();
    let previousBalance = 0;
    prevTransactions.forEach(tx => {
        if (tx.status === 'completed') previousBalance -= (tx.costLYD || 0);
        else if (tx.status === 'deposit') previousBalance += (tx.amount || 0);
        else if (tx.status === 'deduction') previousBalance -= (tx.amount || 0);
    });

    const currentTransactions = await Transaction.find({ ...baseQuery, createdAt: { $gte: start, $lte: end } }).sort({ createdAt: -1 }).lean();

    let totalLYD = 0; let totalEGP = 0;
    let completedCount = 0; let rejectedCount = 0; let totalDeposits = 0;
    const operations = []; const deposits = [];

    currentTransactions.forEach(tx => {
        if (['deposit', 'deduction', 'deposit_pending'].includes(tx.status)) {
            deposits.push(tx);
            if (tx.status === 'deposit') totalDeposits += (tx.amount || 0);
            else if (tx.status === 'deduction') totalDeposits -= (tx.amount || 0);
        } else {
            operations.push(tx);
            if (tx.status === 'completed') {
                completedCount++;
                totalLYD += (tx.costLYD || 0);
                totalEGP += (tx.amount || 0);
            } else if (tx.status === 'rejected' || tx.status === 'cancelled_by_admin') {
                rejectedCount++;
            }
        }
    });

    let statusLabel = 'عميل مباشر';
    if (isEmployee) statusLabel = canViewAll ? 'مدير/مسؤول شركة' : 'موظف شركة';
    else if (isAgentStaff) statusLabel = canViewAll ? 'مدير/مسؤول وكيل' : 'موظف وكيل';
    else if (isSubAccount) statusLabel = 'نقطة بيع';

    const entityInfo = {
        name: account.name || '---',
        phone: account.phone || '---',
        username: account.webUsername || '---',
        joinDate: account.createdAt,
        status: statusLabel
    };

    if (isEmployee && company) {
        entityInfo.status += ` (${company.name})`;
    }
    if (isAgentStaff && company) {
        entityInfo.status += ` (${company.name})`;
    }

    return {
        previousBalance,
        currentTransactions,
        operations,
        deposits,
        totalLYD,
        totalEGP,
        completedCount,
        rejectedCount,
        totalDeposits,
        entityInfo
    };
}

/**
 * 💸 Client Balance Transfer Lookup
 */
async function getBalanceTransferSource(userId, accountType) {
    const isSubAccount = accountType === 'sub_client';
    const isAgentStaff = accountType === 'agent_staff';
    const Model = isSubAccount ? SubAccount : (accountType === 'client_company' ? ClientEmployee : (isAgentStaff ? AgentEmployee : User));
    const account = await Model.findById(userId);
    if (!account) throw new Error('SESSION_EXPIRED');
    if (account.status && account.status !== 'active') throw new Error('SOURCE_INACTIVE');

    if (isSubAccount) {
        return { modelName: 'SubAccount', doc: account };
    }

    if (accountType === 'client_company') {
        const company = await ClientCompany.findById(account.companyId);
        if (!company) throw new Error('COMPANY_NOT_FOUND');
        return { modelName: 'ClientCompany', doc: company, performedBy: account.name };
    }

    if (isAgentStaff) {
        if (account.role === 'accountant') throw new Error('ACCOUNTANT_FORBIDDEN');
        const agent = await User.findById(account.agentId);
        if (!agent || agent.role !== 'agent') throw new Error('AGENT_NOT_FOUND');
        return { modelName: 'User', doc: agent, performedBy: account.name };
    }

    if (account.role === 'accountant') {
        throw new Error('ACCOUNTANT_FORBIDDEN');
    }

    return { modelName: 'User', doc: account };
}

async function lookupBalanceTransfer({ userId, accountType, targetAccountCode }) {
    const source = await getBalanceTransferSource(userId, accountType);
    const targetCode = normalizeAccountCode(targetAccountCode);

    if (!/^\d{4,6}$/.test(targetCode)) {
        throw new Error('INVALID_ACCOUNT_CODE');
    }

    const target = await resolveAccountByCode(targetCode);
    if (!target) throw new Error('TARGET_NOT_FOUND');
    if (source.doc.status !== 'active') throw new Error('SOURCE_INACTIVE');
    if (target.doc.status !== 'active') throw new Error('TARGET_INACTIVE');
    
    if (source.modelName === target.modelName && String(source.doc._id) === String(target.doc._id)) {
        throw new Error('SAME_ACCOUNT');
    }

    return target;
}

/**
 * 💸 Client Balance Transfer Execute (With Idempotency)
 */
async function executeBalanceTransferIdempotent({ userId, accountType, targetAccountCode, amount, notes, req }) {
    const idempotencyKey = req.headers['idempotency-key'];
    const fingerprint = buildIdempotencyFingerprint(req);

    // 1. Check existing
    const existingTx = await Transaction.findOne({ idempotencyKey });
    if (existingTx) {
        if (existingTx.idempotencyFingerprint === fingerprint) {
            return { replayed: true, response: existingTx.idempotencyResponse };
        }
        throw new Error('IDEMPOTENCY_CONFLICT');
    }

    // 2. Lock to prevent race conditions
    const lockKey = `idemp:${idempotencyKey}`;
    let lock;
    try {
        lock = await acquireLock(lockKey, 10000);
    } catch (_) {
        throw new Error('LOCK_TIMEOUT');
    }

    try {
        // Double-check after lock
        const doubleCheckTx = await Transaction.findOne({ idempotencyKey });
        if (doubleCheckTx) {
            if (doubleCheckTx.idempotencyFingerprint === fingerprint) {
                return { replayed: true, response: doubleCheckTx.idempotencyResponse };
            }
            throw new Error('IDEMPOTENCY_CONFLICT');
        }

        const source = await getBalanceTransferSource(userId, accountType);
        
        // Execute the transfer (session handles inside this service)
        const result = await executeBalanceTransfer({
            source,
            targetCode: targetAccountCode,
            amount,
            notes,
            idempotencyKey,
            idempotencyFingerprint: fingerprint
        });

        return { replayed: false, response: result };
    } finally {
        await releaseLock(lock);
    }
}

/**
 * ⚠️ Client Complaint
 */
async function submitClientComplaint({ userId, accountType, transactionId, complaintText }) {
    if (!mongoose.Types.ObjectId.isValid(transactionId)) {
        throw new Error('INVALID_TRANSACTION_ID');
    }

    const tx = await Transaction.findById(transactionId);
    if (!tx) throw new Error('TRANSACTION_NOT_FOUND');

    // Ownership check matching persona
    let hasAccess = false;
    if (accountType === 'client_user') {
        const u = await User.findById(userId);
        const allowedIds = u ? [u.phone, u.webUsername, String(u._id)].filter(Boolean).map(String) : [];
        if (allowedIds.includes(String(tx.userId))) hasAccess = true;
    } else if (accountType === 'sub_client') {
        if (tx.subAccountId && String(tx.subAccountId) === String(userId)) hasAccess = true;
    } else if (accountType === 'client_company') {
        const emp = await ClientEmployee.findById(userId);
        if (emp && tx.companyId && String(tx.companyId) === String(emp.companyId)) {
            hasAccess = true;
        }
    } else if (accountType === 'agent_staff') {
        const emp = await AgentEmployee.findById(userId);
        const agent = emp ? await User.findById(emp.agentId) : null;
        if (agent) {
            const allowedIds = [agent.phone, agent.webUsername, String(agent._id)].filter(Boolean).map(String);
            if (allowedIds.includes(String(tx.userId))) hasAccess = true;
            if (!hasAccess && tx.subAccountId) {
                const ownsSub = await SubAccount.exists({ _id: tx.subAccountId, masterType: 'user', masterId: agent._id });
                if (ownsSub) hasAccess = true;
            }
        }
    }

    if (!hasAccess) throw new Error('FORBIDDEN');

    // Validate transaction status is not rejected or cancelled
    if (['rejected', 'cancelled_by_admin'].includes(tx.status)) {
        throw new Error('INVALID_STATE');
    }

    tx.complaintText = complaintText;
    tx.emergencyAlert = `شكوى عميل: ${complaintText}`;
    await tx.save();

    return tx;
}

/**
 * 🤖 Executor Alert Clearing
 */
async function clearExecutorAlert({ executorId, taskId, alertType }) {
    const emp = await Employee.findById(executorId);
    if (!emp) throw new Error('UNAUTHORIZED');

    const tx = await Transaction.findById(taskId);
    if (!tx) throw new Error('TASK_NOT_FOUND');

    // Enforce group ownership
    const isOwner = String(tx.executorGroupId) === String(emp.groupId) || String(tx.managerGroupId) === String(emp.groupId);
    if (!isOwner) throw new Error('FORBIDDEN');

    if (alertType === 'deposit') {
        tx.executorWebAlert = undefined;
    } else {
        tx.emergencyAlert = undefined;
    }

    await tx.save();
    return true;
}

/**
 * 📥 Executor Deposit Request (With Idempotency)
 */
async function requestExecutorDeposit({ executorId, amount, req }) {
    const idempotencyKey = req.headers['idempotency-key'];
    const fingerprint = buildIdempotencyFingerprint(req);

    const existingTx = await Transaction.findOne({ idempotencyKey });
    if (existingTx) {
        if (existingTx.idempotencyFingerprint === fingerprint) {
            return { replayed: true, response: existingTx.idempotencyResponse };
        }
        throw new Error('IDEMPOTENCY_CONFLICT');
    }

    const lockKey = `idemp:${idempotencyKey}`;
    let lock;
    try {
        lock = await acquireLock(lockKey, 10000);
    } catch (_) {
        throw new Error('LOCK_TIMEOUT');
    }

    try {
        const doubleCheckTx = await Transaction.findOne({ idempotencyKey });
        if (doubleCheckTx) {
            if (doubleCheckTx.idempotencyFingerprint === fingerprint) {
                return { replayed: true, response: doubleCheckTx.idempotencyResponse };
            }
            throw new Error('IDEMPOTENCY_CONFLICT');
        }

        const parsedAmount = parseFloat(amount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) throw new Error('INVALID_AMOUNT');
        const emp = await Employee.findById(executorId).populate('groupId');
        if (!emp) throw new Error('UNAUTHORIZED');

        const customId = await nextDepositRequestId(session);
        const tx = new Transaction({
            userId: 'admin',
            executorGroupId: emp.groupId._id,
            operatorId: emp._id.toString(),
            amount: parsedAmount,
            costLYD: 0,
            vodafoneNumber: 'طلب إيداع',
            status: 'deposit_pending',
            customId,
            companyName: 'طلب إيداع من منفذ',
            employeeName: emp.name,
            executorName: emp.name,
            idempotencyKey,
            idempotencyFingerprint: fingerprint
        });

        const successBody = {
            success: true,
            txId: tx.customId,
            status: tx.status,
            message: 'تم إرسال طلب الإيداع بنجاح'
        };

        tx.idempotencyResponse = successBody;
        await tx.save();

        const msgText = `📥 طلب إيداع نقدية جديد!\n👤 المنفذ: ${emp.name}\n🤖 البوت: ${emp.groupId.name}\n💵 المبلغ المطلوب: ${parsedAmount} EGP\n🧾 رقم: ${tx.customId}`;
        const admins = await Admin.find({});
        const Notification = require('../models/Notification');
        for (const admin of admins) {
            await Notification.create({
                userId: admin.webUsername || 'admin',
                title: 'طلب إيداع نقدية جديد',
                message: msgText,
                type: 'deposit_pending'
            }).catch(()=>{});
        }

        return { replayed: false, response: successBody };
    } finally {
        await releaseLock(lock);
    }
}

/**
 * 👨‍💻 Executor Edit Amount (With Idempotency)
 */
async function editTaskAmount({ executorId, taskId, newAmount, reason, req }) {
    const idempotencyKey = req.headers['idempotency-key'];
    const fingerprint = buildIdempotencyFingerprint(req);

    const existingTx = await Transaction.findOne({ editIdempotencyKey: idempotencyKey });
    if (existingTx) {
        if (existingTx.editIdempotencyFingerprint === fingerprint) {
            return { replayed: true, response: existingTx.editIdempotencyResponse };
        }
        throw new Error('IDEMPOTENCY_CONFLICT');
    }

    const lockKey = `idemp:${idempotencyKey}`;
    let lock;
    try {
        lock = await acquireLock(lockKey, 10000);
    } catch (_) {
        throw new Error('LOCK_TIMEOUT');
    }

    try {
        const doubleCheckTx = await Transaction.findOne({ editIdempotencyKey: idempotencyKey });
        if (doubleCheckTx) {
            if (doubleCheckTx.editIdempotencyFingerprint === fingerprint) {
                return { replayed: true, response: doubleCheckTx.editIdempotencyResponse };
            }
            throw new Error('IDEMPOTENCY_CONFLICT');
        }

        const emp = await Employee.findById(executorId);
        if (!emp) throw new Error('UNAUTHORIZED');

        const tx = await Transaction.findOne({ _id: taskId, status: 'accepted', operatorId: emp._id.toString() });
        if (!tx) throw new Error('INVALID_STATE');

        const parsedAmount = parseFloat(newAmount);
        if (isNaN(parsedAmount) || parsedAmount <= 0) throw new Error('INVALID_AMOUNT');

        const oldAmount = numberOrNull(tx.amount) || 0;
        const oldMasterCost = numberOrNull(tx.costLYD) || 0;
        const masterRate = assertPositiveRate(
            tx.exchangeRate || (oldAmount > 0 && oldMasterCost > 0 ? oldAmount / oldMasterCost : null)
        );
        const newMasterCost = parseFloat((parsedAmount / masterRate).toFixed(3));
        const diffMasterCost = parseFloat((newMasterCost - oldMasterCost).toFixed(3));

        let newSubCost = null;
        let diffSubCost = 0;
        if (tx.isSubAccountTx && tx.subAccountId) {
            const oldSubCost = numberOrNull(tx.subAccountCostLYD) ?? oldMasterCost;
            const subRate = assertPositiveRate(
                tx.subClientRate || (oldAmount > 0 && oldSubCost > 0 ? oldAmount / oldSubCost : null) || masterRate
            );
            newSubCost = parseFloat((parsedAmount / subRate).toFixed(3));
            diffSubCost = parseFloat((newSubCost - oldSubCost).toFixed(3));
        }

        const session = await mongoose.startSession();
        session.startTransaction();

        try {
            if (tx.isSubAccountTx && tx.subAccountId) {
                const subAccount = await SubAccount.findById(tx.subAccountId).session(session);
                if (!subAccount) throw new Error('ACCOUNT_NOT_FOUND');

                await updateBalanceWithCreditLimit({
                    Model: SubAccount,
                    id: subAccount._id,
                    diff: diffSubCost,
                    session
                });

                const MasterModel = subAccount.masterType === 'company' ? ClientCompany : User;
                await updateBalanceWithCreditLimit({
                    Model: MasterModel,
                    id: subAccount.masterId,
                    diff: diffMasterCost,
                    session
                });
            } else if (tx.companyId) {
                await updateBalanceWithCreditLimit({
                    Model: ClientCompany,
                    id: tx.companyId,
                    diff: diffMasterCost,
                    session
                });
            } else if (tx.userId) {
                const user = await User.findOne({ $or: [{ phone: tx.userId }, { webUsername: tx.userId }] }).session(session);
                if (!user) throw new Error('ACCOUNT_NOT_FOUND');
                await updateBalanceWithCreditLimit({
                    Model: User,
                    id: user._id,
                    diff: diffMasterCost,
                    session
                });
            } else {
                throw new Error('ACCOUNT_NOT_FOUND');
            }

            tx.amount = parsedAmount;
            tx.costLYD = newMasterCost;
            if (newSubCost !== null) {
                tx.subAccountCostLYD = newSubCost;
                tx.commission = parseFloat((newSubCost - newMasterCost).toFixed(3));
                tx.masterProfit = tx.commission;
            }
            appendAdminNote(tx, `[تعديل المبلغ من ${oldAmount} إلى ${parsedAmount} | السبب: ${reason}]`);
            
            const successResponse = {
                success: true,
                newAmount: parsedAmount,
                newCostLYD: newMasterCost,
                newSubAccountCostLYD: newSubCost
            };

            tx.editIdempotencyKey = idempotencyKey;
            tx.editIdempotencyFingerprint = fingerprint;
            tx.editIdempotencyResponse = successResponse;

            await tx.save({ session });
            await session.commitTransaction();
            session.endSession();

            return { replayed: false, response: successResponse };
        } catch (err) {
            await session.abortTransaction();
            session.endSession();
            throw err;
        }
    } finally {
        await releaseLock(lock);
    }
}

/**
 * 👨‍💻 Executor Return Task
 */
async function returnTask({ executorId, taskId, reason }) {
    const emp = await Employee.findById(executorId);
    if (!emp) throw new Error('UNAUTHORIZED');

    const tx = await Transaction.findById(taskId);
    if (!tx || tx.status !== 'accepted' || tx.operatorId !== emp._id.toString()) {
        throw new Error('INVALID_STATE');
    }

    tx.status = 'pending';
    tx.executorGroupId = undefined;
    tx.managerGroupId = undefined;
    tx.executorName = undefined;
    tx.operatorId = undefined;
    tx.broadcastMessages = [];
    appendAdminNote(tx, `[إرجاع للإدارة | السبب: ${reason}]`);
    await tx.save();
    return true;
}

/**
 * 👨‍💻 Executor ZaynPay Execute (With Idempotency)
 */
async function executeZaynPayIdempotent({ executorId, taskId, req }) {
    const idempotencyKey = req.headers['idempotency-key'];
    const fingerprint = buildIdempotencyFingerprint(req);

    const existingTx = await Transaction.findOne({ zaynpayIdempotencyKey: idempotencyKey });
    if (existingTx) {
        if (existingTx.zaynpayIdempotencyFingerprint === fingerprint) {
            return { replayed: true, response: existingTx.zaynpayIdempotencyResponse };
        }
        throw new Error('IDEMPOTENCY_CONFLICT');
    }

    const lockKey = `idemp:${idempotencyKey}`;
    let lock;
    try {
        lock = await acquireLock(lockKey, 10000);
    } catch (_) {
        throw new Error('LOCK_TIMEOUT');
    }

    try {
        const doubleCheckTx = await Transaction.findOne({ zaynpayIdempotencyKey: idempotencyKey });
        if (doubleCheckTx) {
            if (doubleCheckTx.zaynpayIdempotencyFingerprint === fingerprint) {
                return { replayed: true, response: doubleCheckTx.zaynpayIdempotencyResponse };
            }
            throw new Error('IDEMPOTENCY_CONFLICT');
        }

        const emp = await Employee.findById(executorId).populate('groupId');
        if (!emp || emp.webUsername !== 'zaynapi@ahram.com') {
            throw new Error('FORBIDDEN');
        }
        if (emp.status && emp.status !== 'active') {
            throw new Error('FORBIDDEN');
        }
        if (!emp.groupId || !emp.groupId._id) {
            throw new Error('FORBIDDEN');
        }

        const tx = await Transaction.findById(taskId);
        if (!tx) throw new Error('TASK_NOT_FOUND');
        assertGroupOwnsTask(tx, emp.groupId._id);
        if (tx.status !== 'accepted' || tx.operatorId !== emp._id.toString()) {
            throw new Error('INVALID_STATE');
        }

        const executorDebit = numberOrNull(tx.amount);
        if (!executorDebit || executorDebit <= 0) throw new Error('INVALID_AMOUNT');

        const zaynpay = require('./zaynpayApi');
        const walletNumber = tx.vodafoneNumber || tx.accountNumber;
        if (!walletNumber) throw new Error('INVALID_WALLET');

        const parentGroupId = emp.groupId.parentGroupId || emp.groupId.parentBotId;
        const parentGroup = parentGroupId
            ? await ExecutorGroup.findById(parentGroupId)
            : null;
        if (parentGroup && Number(parentGroup.balance || 0) < executorDebit) {
            throw new Error('INSUFFICIENT_EXECUTOR_BALANCE');
        }
        if (Number(emp.groupId.balance || 0) < executorDebit) {
            throw new Error('INSUFFICIENT_EXECUTOR_BALANCE');
        }

        // 1. Inquiry
        const paymentBillInfo = await zaynpay.inquiry(walletNumber, tx.amount);

        // 2. Pay
        const paymentRes = await zaynpay.pay(paymentBillInfo, walletNumber, tx.amount);
        if (!paymentRes.success) {
            throw new Error(paymentRes.error || 'ZaynPay payment failed');
        }

        // Generate receipt
        const { generateReceiptBase64 } = require('../utils/receiptGenerator');
        const trimmedWallet = walletNumber.trim();
        const maskedPhone = trimmedWallet.length > 8
            ? trimmedWallet.substring(0, 4) + '****' + trimmedWallet.substring(trimmedWallet.length - 3)
            : '****';
        const receiptBase64 = await generateReceiptBase64({
            amount: tx.amount,
            walletNumber: walletNumber,
            senderPhone: maskedPhone,
            customId: tx.customId || tx._id.toString().slice(-6),
            accountName: tx.companyName || tx.employeeName || 'غير محدد',
            date: new Date().toLocaleDateString('en-GB', { timeZone: 'Africa/Tripoli' })
        });

        const buffers = [Buffer.from(receiptBase64.replace(/^data:image\/\w+;base64,/, ""), 'base64')];
        const proofsDir = path.join(process.cwd(), 'uploads', 'proofs');
        if (!fs.existsSync(proofsDir)) { fs.mkdirSync(proofsDir, { recursive: true }); }
        
        const safeId = (tx.customId || tx._id.toString().slice(-6)).toString().replace(/[^a-zA-Z0-9_-]/g, '');
        const fileName = `${safeId}_zaynpay.jpg`;
        fs.writeFileSync(path.join(proofsDir, fileName), buffers[0]);

        const successResponse = {
            success: true,
            status: 'completed',
            transactionNumber: paymentRes.transactionNumber
        };

        const session = await mongoose.startSession();
        session.startTransaction();
        try {
            if (parentGroupId) {
                const parentUpdated = await ExecutorGroup.findOneAndUpdate(
                    { _id: parentGroupId, balance: { $gte: executorDebit } },
                    { $inc: { balance: -executorDebit } },
                    { new: true, session }
                );
                if (!parentUpdated) throw new Error('INSUFFICIENT_EXECUTOR_BALANCE');
            }

            const groupUpdated = await ExecutorGroup.findOneAndUpdate(
                { _id: emp.groupId._id, balance: { $gte: executorDebit } },
                { $inc: { balance: -executorDebit } },
                { new: true, session }
            );
            if (!groupUpdated) throw new Error('INSUFFICIENT_EXECUTOR_BALANCE');

            tx.status = 'completed';
            tx.proofImage = fileName;
            tx.proofImages = [fileName];
            appendCustomerReference(tx, 'الرقم المرجعي', paymentRes.refNumber);
            appendCustomerReference(tx, 'رقم العملية الخارجي', paymentRes.transactionNumber);
            appendAdminNote(tx, `[ZaynPay Auto-Executed | Ref: ${paymentRes.refNumber} | TxNo: ${paymentRes.transactionNumber}]`);
            tx.completedAt = new Date();
            tx.completedBy = emp._id;
            tx.zaynpayIdempotencyKey = idempotencyKey;
            tx.zaynpayIdempotencyFingerprint = fingerprint;
            tx.zaynpayIdempotencyResponse = successResponse;

            await tx.save({ session });
            await session.commitTransaction();
            session.endSession();
        } catch (err) {
            await session.abortTransaction();
            session.endSession();
            throw err;
        }

        return { replayed: false, response: successResponse };
    } finally {
        await releaseLock(lock);
    }
}

/**
 * 👨‍💻 Executor Support Messages
 */
async function getExecutorSupportTicket({ executorId }) {
    const emp = await Employee.findById(executorId);
    if (!emp) throw new Error('UNAUTHORIZED');

    let ticket = await SupportTicket.findOne({ entityType: 'executor', entityId: emp._id }).sort({ createdAt: -1 });
    if (!ticket) {
        ticket = new SupportTicket({
            entityType: 'executor',
            entityId: emp._id,
            telegramId: emp.phone || emp.webUsername,
            name: emp.name || 'منفذ',
            phone: emp.phone || 'غير مسجل',
            messages: []
        });
        await ticket.save();
    } else {
        ticket.unreadUser = 0;
        await ticket.save();
    }
    return ticket;
}

async function sendExecutorSupportReply({ executorId, text, imageBase64 }) {
    const emp = await Employee.findById(executorId);
    if (!emp) throw new Error('UNAUTHORIZED');

    let ticket = await SupportTicket.findOne({ entityType: 'executor', entityId: emp._id, status: { $ne: 'closed' } });
    if (!ticket) {
        ticket = new SupportTicket({
            entityType: 'executor',
            entityId: emp._id,
            telegramId: emp.phone || emp.webUsername,
            name: emp.name || 'منفذ',
            phone: emp.phone || 'غير مسجل',
            messages: []
        });
    }

    let imageUrl = null;
    if (imageBase64) {
        const parsedImage = parseSupportImage(imageBase64);
        const uploadDir = path.join(process.cwd(), 'uploads', 'support');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        const fileName = `support_exec_${crypto.randomBytes(16).toString('hex')}.${parsedImage.ext}`;
        const uploadPath = path.join(uploadDir, fileName);
        fs.writeFileSync(uploadPath, parsedImage.buffer);
        imageUrl = `/uploads/support/${fileName}`;
    }

    const newMsg = {
        sender: 'user',
        text: text || '',
        imageUrl: imageUrl || '',
        createdAt: new Date()
    };

    ticket.messages.push(newMsg);
    ticket.status = 'open';
    ticket.unreadAdmin = (ticket.unreadAdmin || 0) + 1;
    await ticket.save();

    const Notification = require('../models/Notification');
    const admins = await Admin.find({});
    const notifyMsg = `🚨 رسالة دعم فني جديدة (منفذ)!\n👤 من: ${emp.name}\n💬 الرسالة: ${text || 'صورة مرفقة'}`;
    for (const admin of admins) {
        await Notification.create({
            userId: admin.webUsername || 'admin',
            title: 'رسالة دعم فني جديدة',
            message: notifyMsg,
            type: 'support_message'
        }).catch(()=>{});
    }

    return newMsg;
}

/**
 * 📊 Executor Reports Parity
 */
async function getExecutorReports({ executorId, dateType, dateValue }) {
    const emp = await Employee.findById(executorId);
    if (!emp) throw new Error('UNAUTHORIZED');

    const isManager = emp.role === 'manager';
    const isAccountant = emp.role === 'accountant';
    const isEmployee = !isManager && !isAccountant;

    let finalDateType = dateType;
    let finalDateValue = dateValue;

    if (isEmployee || (!isManager && !emp.canViewAllReports)) {
        finalDateType = 'day';
        const today = new Date();
        finalDateValue = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    }

    let { start, end } = getDateRange(
        finalDateType === 'day' ? finalDateValue : null,
        finalDateType === 'month' ? finalDateValue : null
    );

    let baseQuery = {
        $or: [
            { executorGroupId: emp.groupId },
            { managerGroupId: emp.groupId }
        ]
    };

    if (isEmployee) {
        baseQuery.status = { $in: ['completed', 'rejected', 'cancelled_by_admin', 'failed'] };
        if (!emp.canViewAllReports) {
            baseQuery.operatorId = emp._id.toString();
        }
    } else {
        if (!isManager && !emp.canViewAllReports) {
            baseQuery.operatorId = emp._id.toString();
        }
    }

    const currentTransactions = await Transaction.find({ ...baseQuery, createdAt: { $gte: start, $lte: end } }).sort({ createdAt: -1 }).lean();

    let totalLYD = 0; let totalEGP = 0;
    let completedCount = 0; let rejectedCount = 0;
    const operations = []; const deposits = [];

    currentTransactions.forEach(tx => {
        if (tx.status === 'completed') {
            totalLYD += (tx.costLYD || 0);
            totalEGP += (tx.amount || 0);
            completedCount++;
        } else if (tx.status === 'rejected' || tx.status === 'cancelled_by_admin') {
            rejectedCount++;
        }
        if (['deposit', 'deduction', 'deposit_pending'].includes(tx.status)) {
            deposits.push(tx);
        } else {
            operations.push(tx);
        }
    });

    const previousBalance = 0;

    const entityInfo = {
        name: emp.name,
        phone: emp.phone || '---',
        username: emp.webUsername,
        joinDate: emp.createdAt,
        status: isManager ? 'مدير شركة تنفيذ' : 'موظف منفذ مالي'
    };

    return {
        previousBalance,
        currentTransactions,
        operations,
        deposits,
        totalLYD,
        totalEGP,
        completedCount,
        rejectedCount,
        totalDeposits: 0,
        entityInfo
    };
}

/**
 * 👥 Executor Employee Management (Manager only)
 */
async function checkManagerPermission(executorId) {
    const emp = await Employee.findById(executorId);
    if (!emp) throw new Error('UNAUTHORIZED');
    if (emp.role !== 'manager') throw new Error('FORBIDDEN');
    return emp;
}

async function getEmployeesList(executorId) {
    const manager = await checkManagerPermission(executorId);
    return await Employee.find({ groupId: manager.groupId }).sort({ role: 1, createdAt: -1 }).lean();
}

async function createEmployee({ executorId, name, phone, role, webUsername, webPassword, tenantId }) {
    const manager = await checkManagerPermission(executorId);
    if (!['operator', 'accountant'].includes(role)) throw new Error('INVALID_ROLE');
    
    const prefix = webUsername.replace(/@ahram\.com$/i, '').trim();
    if (!/^[a-zA-Z0-9_]+$/.test(prefix)) throw new Error('INVALID_USERNAME');
    const finalUsername = prefix + '@ahram.com';

    const existing = await Employee.findOne({ webUsername: finalUsername });
    if (existing) throw new Error('USERNAME_TAKEN');

    const createdEmp = await Employee.create({
        name,
        phone: phone || '',
        role,
        status: 'active',
        groupId: manager.groupId,
        webUsername: finalUsername,
        webPassword, // Pre-save hook hashes it automatically
        tenantId
    });

    await logAction({
        action: 'USER_CREATED',
        performedById: manager._id,
        performedByModel: 'Employee',
        performedByName: manager.name,
        targetId: createdEmp._id,
        targetModel: 'Employee',
        result: 'ناجح',
        metadata: { role, username: finalUsername, name }
    });

    return createdEmp;
}

async function toggleEmployeeStatus({ executorId, targetId }) {
    const manager = await checkManagerPermission(executorId);
    const emp = await Employee.findById(targetId);
    if (!emp || String(emp.groupId) !== String(manager.groupId)) throw new Error('NOT_FOUND');
    if (emp.role === 'manager') throw new Error('FORBIDDEN');

    emp.status = emp.status === 'active' ? 'suspended' : 'active';
    await emp.save();
    return emp;
}

async function toggleEmployeeReports({ executorId, targetId }) {
    const manager = await checkManagerPermission(executorId);
    const emp = await Employee.findById(targetId);
    if (!emp || String(emp.groupId) !== String(manager.groupId)) throw new Error('NOT_FOUND');
    if (emp.role === 'manager') throw new Error('FORBIDDEN');

    emp.canViewAllReports = !emp.canViewAllReports;
    await emp.save();
    return emp;
}

async function resetEmployeePassword({ executorId, targetId, newPassword }) {
    const manager = await checkManagerPermission(executorId);
    const emp = await Employee.findById(targetId);
    if (!emp || String(emp.groupId) !== String(manager.groupId)) throw new Error('NOT_FOUND');
    if (emp.role === 'manager') throw new Error('FORBIDDEN');

    emp.webPassword = newPassword; // Pre-save hook hashes it
    await emp.save();

    await logAction({
        action: 'USER_PASSWORD_CHANGED',
        performedById: manager._id,
        performedByModel: 'Employee',
        performedByName: manager.name,
        targetId: emp._id,
        targetModel: 'Employee',
        result: 'ناجح',
        metadata: { username: emp.webUsername } // DO NOT include plain-text password or password hash here!
    });

    return true;
}

async function deleteEmployee({ executorId, targetId }) {
    const manager = await checkManagerPermission(executorId);
    const emp = await Employee.findById(targetId);
    if (!emp || String(emp.groupId) !== String(manager.groupId)) throw new Error('NOT_FOUND');
    if (emp.role === 'manager') throw new Error('FORBIDDEN');

    await Employee.findByIdAndDelete(targetId);
    return true;
}

module.exports = {
    getClientReports,
    lookupBalanceTransfer,
    executeBalanceTransferIdempotent,
    submitClientComplaint,
    clearExecutorAlert,
    requestExecutorDeposit,
    editTaskAmount,
    returnTask,
    executeZaynPayIdempotent,
    getExecutorSupportTicket,
    sendExecutorSupportReply,
    getExecutorReports,
    getEmployeesList,
    createEmployee,
    toggleEmployeeStatus,
    toggleEmployeeReports,
    resetEmployeePassword,
    deleteEmployee
};
