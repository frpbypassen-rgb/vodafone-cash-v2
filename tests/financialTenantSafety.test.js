'use strict';

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const fs = require('fs');
const path = require('path');

mongoose.set('autoIndex', false);

jest.setTimeout(180000);

const Tenant = require('../models/Tenant');
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const SubAccount = require('../models/SubAccount');
const Transaction = require('../models/Transaction');
const Ledger = require('../models/Ledger');
const JournalEvent = require('../models/JournalEvent');
const AuditLog = require('../models/AuditLog');
const AccountCode = require('../models/AccountCode');
const Counter = require('../models/Counter');
const Notification = require('../models/Notification');
const { resolveAccountByCode } = require('../services/accountCodeService');
const { executeBalanceTransfer } = require('../services/balanceTransferService');
const { calculateHash, logAction } = require('../services/auditService');
const { runBackfill } = require('../scripts/backfillFinancialTenantId');
const { runPrepare } = require('../scripts/prepareAccountCodeTenantIndex');
const { reversalService } = require('../src/Application/Services/ReversalService');

const sourceOf = (doc) => ({ modelName: 'User', doc });
const requestFor = (tenant, body = {}) => ({
    tenantId: tenant._id,
    tenant,
    headers: {},
    method: 'POST',
    originalUrl: '/client/balance-transfer',
    ip: '127.0.0.1',
    body
});

describe('financial tenant safety', () => {
    let replset;
    let tenantA;
    let tenantB;
    let userA;
    let userA2;
    let userB;
    const originalEnv = {};

    const remember = (name) => {
        originalEnv[name] = process.env[name];
    };
    const restoreEnv = () => {
        for (const [name, value] of Object.entries(originalEnv)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    };

    beforeAll(async () => {
        remember('FINANCIAL_TENANT_GUARD');
        remember('FINANCIAL_IDEMPOTENCY_REQUIRED');
        remember('FINANCIAL_IDEMPOTENCY_ENABLED');
        remember('FINANCIAL_AUDIT_IN_TRANSACTION');
        remember('FINANCIAL_REDIS_FAIL_CLOSED');
        remember('FINANCIAL_BLOCK_MASTER_SUB_TENANT_MISMATCH');
        remember('MONGO_TRANSACTIONS_REQUIRED');
        remember('REDIS_REQUIRED');
        remember('NODE_ENV');
        process.env.NODE_ENV = 'test';
        process.env.FINANCIAL_TENANT_GUARD = 'true';
        process.env.FINANCIAL_IDEMPOTENCY_ENABLED = 'true';
        delete process.env.REDIS_REQUIRED;
        delete process.env.MONGO_TRANSACTIONS_REQUIRED;
        delete process.env.FINANCIAL_REDIS_FAIL_CLOSED;
        delete process.env.FINANCIAL_AUDIT_IN_TRANSACTION;

        replset = await MongoMemoryReplSet.create({
            replSet: { count: 1, storageEngine: 'wiredTiger' }
        });
        if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
        await mongoose.connect(replset.getUri());
        for (const model of [Transaction, Ledger, JournalEvent, AuditLog, AccountCode, Counter, Notification, User, ClientCompany, SubAccount]) {
            await model.createCollection().catch((error) => {
                if (error.code !== 48) throw error;
            });
            await model.createIndexes().catch((error) => {
                if (![85, 86].includes(error.code)) throw error;
            });
        }

        tenantA = await Tenant.create({ name: 'شركة الأهرام للاختبار', slug: 'safety-ahram', status: 'active' });
        tenantB = await Tenant.create({ name: 'شركة النيل للاختبار', slug: 'safety-nile', status: 'active' });
        userA = await User.create({
            name: 'حساب الأهرام',
            webUsername: 'safety-user-a',
            webPassword: 'secret123',
            phone: '01010000001',
            accountCode: '111111',
            balance: 1000,
            status: 'active',
            tenantId: tenantA._id
        });
        userA2 = await User.create({
            name: 'حساب الأهرام الثاني',
            webUsername: 'safety-user-a2',
            webPassword: 'secret123',
            phone: '01010000002',
            accountCode: '111112',
            balance: 100,
            status: 'active',
            tenantId: tenantA._id
        });
        userB = await User.create({
            name: 'حساب النيل',
            webUsername: 'safety-user-b',
            webPassword: 'secret123',
            phone: '01020000001',
            accountCode: '222222',
            balance: 800,
            status: 'active',
            tenantId: tenantB._id
        });
    });

    afterAll(async () => {
        restoreEnv();
        await mongoose.disconnect();
        if (replset) await replset.stop();
    });

    beforeEach(() => {
        process.env.FINANCIAL_TENANT_GUARD = 'true';
        process.env.FINANCIAL_IDEMPOTENCY_ENABLED = 'true';
        delete process.env.REDIS_REQUIRED;
        delete process.env.MONGO_TRANSACTIONS_REQUIRED;
        delete process.env.FINANCIAL_REDIS_FAIL_CLOSED;
        delete process.env.FINANCIAL_AUDIT_IN_TRANSACTION;
        process.env.NODE_ENV = 'test';
    });

    test('two organizations keep separate accounts', async () => {
        expect(String(userA.tenantId)).toBe(String(tenantA._id));
        expect(String(userB.tenantId)).toBe(String(tenantB._id));
        expect(String(userA.tenantId)).not.toBe(String(userB.tenantId));
    });

    test('cross-tenant lookup is rejected and ignores a client-sent tenantId', async () => {
        const req = requestFor(tenantA, { tenantId: String(tenantB._id), accountCode: '222222' });
        await expect(resolveAccountByCode('222222', req)).rejects.toMatchObject({
            code: 'CROSS_TENANT_ACCOUNT',
            statusCode: 403
        });
        const same = await resolveAccountByCode('111112', req);
        expect(String(same.doc._id)).toBe(String(userA2._id));
    });

    test('cross-tenant transfer is rejected with zero balance change', async () => {
        const beforeA = (await User.findById(userA._id)).balance;
        const beforeB = (await User.findById(userB._id)).balance;
        await expect(executeBalanceTransfer({
            source: sourceOf(await User.findById(userA._id)),
            targetCode: '222222',
            amount: 40,
            tenantContext: requestFor(tenantA)
        })).rejects.toMatchObject({ code: 'CROSS_TENANT_ACCOUNT' });
        expect((await User.findById(userA._id)).balance).toBe(beforeA);
        expect((await User.findById(userB._id)).balance).toBe(beforeB);
    });

    test('in-tenant transfer is balanced and the balance matches the ledger', async () => {
        const beforeA = (await User.findById(userA._id)).balance;
        const beforeA2 = (await User.findById(userA2._id)).balance;
        const result = await executeBalanceTransfer({
            source: sourceOf(await User.findById(userA._id)),
            targetCode: '111112',
            amount: 25,
            notes: 'تحويل داخلي',
            tenantContext: requestFor(tenantA)
        });
        expect(result.success).toBe(true);
        expect(result.transferId).toMatch(/^BTR-/);
        const entries = await Ledger.find({ transactionId: result.transferId }).lean();
        expect(entries).toHaveLength(2);
        expect(entries.reduce((sum, entry) => sum + entry.amount, 0)).toBe(0);
        expect(entries.every((entry) => String(entry.tenantId) === String(tenantA._id))).toBe(true);
        const txs = await Transaction.find({ customId: { $in: [`${result.transferId}-D`, `${result.transferId}-C`] } }).lean();
        expect(txs).toHaveLength(2);
        expect(txs.every((tx) => String(tx.tenantId) === String(tenantA._id))).toBe(true);
        const afterA = (await User.findById(userA._id)).balance;
        const afterA2 = (await User.findById(userA2._id)).balance;
        expect(afterA).toBe(beforeA - 25);
        expect(afterA2).toBe(beforeA2 + 25);
        const sourceRows = await Ledger.find({ entityId: userA._id }).lean();
        const targetRows = await Ledger.find({ entityId: userA2._id }).lean();
        expect(afterA - beforeA).toBe(-25);
        expect(sourceRows.filter((row) => row.transactionId === result.transferId)
            .reduce((sum, row) => sum + row.amount, 0)).toBe(-25);
        expect(targetRows.filter((row) => row.transactionId === result.transferId)
            .reduce((sum, row) => sum + row.amount, 0)).toBe(25);
        expect(afterA).toBe(beforeA + sourceRows.filter((row) => row.transactionId === result.transferId)
            .reduce((sum, row) => sum + row.amount, 0));
        expect(afterA2).toBe(beforeA2 + targetRows.filter((row) => row.transactionId === result.transferId)
            .reduce((sum, row) => sum + row.amount, 0));
    });

    test('the same Idempotency-Key does not debit twice', async () => {
        const key = '11111111-1111-4111-8111-111111111111';
        const before = (await User.findById(userA._id)).balance;
        const payload = {
            source: sourceOf(await User.findById(userA._id)),
            targetCode: '111112',
            amount: 10,
            notes: 'إعادة',
            idempotencyKey: key,
            idempotencyChannel: 'web-balance-transfer',
            idempotencyPayload: { targetAccountCode: '111112', amount: 10, notes: 'إعادة' },
            tenantContext: requestFor(tenantA)
        };
        const first = await executeBalanceTransfer(payload);
        const second = await executeBalanceTransfer({
            ...payload,
            source: sourceOf(await User.findById(userA._id))
        });
        expect(second.replayed).toBe(true);
        expect(second.transferId || second.clientResponse.transferId).toBe(first.transferId);
        expect((await User.findById(userA._id)).balance).toBe(before - 10);
        expect(await Transaction.countDocuments({ idempotencyKey: key })).toBe(1);
    });

    test('the same key with a different request returns 409', async () => {
        const key = '22222222-2222-4222-8222-222222222222';
        await executeBalanceTransfer({
            source: sourceOf(await User.findById(userA._id)),
            targetCode: '111112',
            amount: 5,
            notes: 'أول',
            idempotencyKey: key,
            tenantContext: requestFor(tenantA)
        });
        const before = (await User.findById(userA._id)).balance;
        await expect(executeBalanceTransfer({
            source: sourceOf(await User.findById(userA._id)),
            targetCode: '111112',
            amount: 6,
            notes: 'أول',
            idempotencyKey: key,
            tenantContext: requestFor(tenantA)
        })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', statusCode: 409 });
        expect((await User.findById(userA._id)).balance).toBe(before);
    });

    test('a ledger write failure rolls the debit back', async () => {
        const beforeA = (await User.findById(userA._id)).balance;
        const beforeA2 = (await User.findById(userA2._id)).balance;
        const original = Ledger.create.bind(Ledger);
        Ledger.create = () => Promise.reject(new Error('LEDGER_WRITE_FAILED'));
        try {
            await expect(executeBalanceTransfer({
                source: sourceOf(await User.findById(userA._id)),
                targetCode: '111112',
                amount: 7,
                tenantContext: requestFor(tenantA)
            })).rejects.toThrow('LEDGER_WRITE_FAILED');
        } finally {
            Ledger.create = original;
        }
        expect((await User.findById(userA._id)).balance).toBe(beforeA);
        expect((await User.findById(userA2._id)).balance).toBe(beforeA2);
    });

    test('a transaction write failure rolls the debit back', async () => {
        const beforeA = (await User.findById(userA._id)).balance;
        const beforeA2 = (await User.findById(userA2._id)).balance;
        const original = Transaction.create.bind(Transaction);
        Transaction.create = () => Promise.reject(new Error('TX_WRITE_FAILED'));
        try {
            await expect(executeBalanceTransfer({
                source: sourceOf(await User.findById(userA._id)),
                targetCode: '111112',
                amount: 8,
                tenantContext: requestFor(tenantA)
            })).rejects.toThrow('TX_WRITE_FAILED');
        } finally {
            Transaction.create = original;
        }
        expect((await User.findById(userA._id)).balance).toBe(beforeA);
        expect((await User.findById(userA2._id)).balance).toBe(beforeA2);
    });

    test('missing MongoDB transactions block the debit', async () => {
        process.env.MONGO_TRANSACTIONS_REQUIRED = 'true';
        const admin = mongoose.connection.db.admin.bind(mongoose.connection.db);
        mongoose.connection.db.admin = () => ({ command: async () => null });
        const beforeA = (await User.findById(userA._id)).balance;
        const beforeA2 = (await User.findById(userA2._id)).balance;
        await expect(executeBalanceTransfer({
            source: sourceOf(await User.findById(userA._id)),
            targetCode: '111112',
            amount: 9,
            tenantContext: requestFor(tenantA)
        })).rejects.toMatchObject({ code: 'FINANCIAL_TRANSACTIONS_UNAVAILABLE' });
        mongoose.connection.db.admin = admin;
        expect((await User.findById(userA._id)).balance).toBe(beforeA);
        expect((await User.findById(userA2._id)).balance).toBe(beforeA2);
    });

    test('Redis lock failure in required mode blocks before debit', async () => {
        process.env.REDIS_REQUIRED = 'true';
        process.env.FINANCIAL_REDIS_FAIL_CLOSED = 'true';
        const beforeA = (await User.findById(userA._id)).balance;
        const beforeA2 = (await User.findById(userA2._id)).balance;
        await expect(executeBalanceTransfer({
            source: sourceOf(await User.findById(userA._id)),
            targetCode: '111112',
            amount: 4,
            tenantContext: requestFor(tenantA)
        })).rejects.toMatchObject({ code: 'REDIS_LOCK_FAILED', statusCode: 503 });
        expect((await User.findById(userA._id)).balance).toBe(beforeA);
        expect((await User.findById(userA2._id)).balance).toBe(beforeA2);
    });

    test('missing Redis does not reject a transfer while the fail-closed flag is off', async () => {
        process.env.REDIS_REQUIRED = 'true';
        delete process.env.FINANCIAL_REDIS_FAIL_CLOSED;
        const beforeA = (await User.findById(userA._id)).balance;
        const beforeA2 = (await User.findById(userA2._id)).balance;
        const result = await executeBalanceTransfer({
            source: sourceOf(await User.findById(userA._id)),
            targetCode: '111112',
            amount: 2,
            tenantContext: requestFor(tenantA)
        });
        expect(result.success).toBe(true);
        expect((await User.findById(userA._id)).balance).toBe(beforeA - 2);
        expect((await User.findById(userA2._id)).balance).toBe(beforeA2 + 2);
    });

    test('an Idempotency-Key is ignored until FINANCIAL_IDEMPOTENCY_ENABLED is set', async () => {
        delete process.env.FINANCIAL_IDEMPOTENCY_ENABLED;
        const key = '44444444-4444-4444-8444-444444444444';
        const before = (await User.findById(userA._id)).balance;
        const payload = {
            source: sourceOf(await User.findById(userA._id)),
            targetCode: '111112',
            amount: 1,
            idempotencyKey: key,
            tenantContext: requestFor(tenantA)
        };
        await executeBalanceTransfer(payload);
        await executeBalanceTransfer({
            ...payload,
            source: sourceOf(await User.findById(userA._id))
        });
        expect((await User.findById(userA._id)).balance).toBe(before - 2);
        expect(await Transaction.countDocuments({ idempotencyKey: key })).toBe(0);
    });

    test('concurrent identical and conflicting requests produce one debit', async () => {
        const key = '33333333-3333-4333-8333-333333333333';
        const fresh = await User.findById(userA._id);
        const before = fresh.balance;
        const call = (amount) => executeBalanceTransfer({
            source: sourceOf(fresh),
            targetCode: '111112',
            amount,
            notes: 'تزامن',
            idempotencyKey: key,
            idempotencyChannel: 'web-balance-transfer',
            idempotencyPayload: { targetAccountCode: '111112', amount, notes: 'تزامن' },
            tenantContext: requestFor(tenantA)
        });
        const identical = Array.from({ length: 24 }, () => call(3));
        const conflicting = Array.from({ length: 12 }, () => call(9));
        const settled = await Promise.allSettled([...identical, ...conflicting]);
        const rejected = settled.filter((item) => item.status === 'rejected');
        expect(rejected.length).toBeGreaterThan(0);
        expect(rejected.every((item) => item.reason && item.reason.code === 'IDEMPOTENCY_CONFLICT')).toBe(true);
        expect(await Transaction.countDocuments({ idempotencyKey: key })).toBe(1);
        const delta = before - (await User.findById(userA._id)).balance;
        expect([3, 9]).toContain(delta);
    });

    test('cancelling twice does not refund twice', async () => {
        const account = await User.create({
            name: 'حساب الإلغاء',
            webUsername: 'safety-cancel',
            webPassword: 'secret123',
            phone: '01010000009',
            accountCode: '111119',
            balance: 80,
            status: 'active',
            tenantId: tenantA._id
        });
        const tx = await Transaction.create({
            customId: 'ATT-CANCEL-0001',
            userId: account.phone,
            amount: 100,
            costLYD: 20,
            status: 'completed',
            transferType: 'vodafone',
            tenantId: tenantA._id
        });
        const first = await reversalService.reverseTransaction(String(tx._id), 'اختبار إلغاء', 'مشرف الاختبار');
        const second = await reversalService.reverseTransaction(String(tx._id), 'اختبار إلغاء', 'مشرف الاختبار');
        expect(first.success).toBe(true);
        expect(second.success).toBe(false);
        expect((await User.findById(account._id)).balance).toBe(100);
        const refunds = await Ledger.find({ transactionId: tx.customId, type: 'REFUND' }).lean();
        expect(refunds).toHaveLength(1);
        expect(String(refunds[0].tenantId)).toBe(String(tenantA._id));
    });

    test('audit hash input ignores tenantId and production blocks audit updates', async () => {
        const base = {
            action: 'LOGIN_SUCCESS',
            performedBy: null,
            performedByModel: 'System',
            performedByName: 'System',
            targetId: null,
            targetModel: null,
            ipAddress: 'system',
            userAgent: 'system',
            endpoint: null,
            success: true,
            result: 'ناجح',
            initiator: 'موقع',
            deviceType: 'كمبيوتر',
            severity: 'info',
            previousHash: 'GENESIS'
        };
        expect(calculateHash(base, 'GENESIS')).toBe(calculateHash({ ...base, tenantId: String(tenantA._id) }, 'GENESIS'));
        await logAction({
            action: 'SETTINGS_CHANGED',
            req: requestFor(tenantA),
            tenantId: tenantA._id,
            newData: { otpCode: '123456', password: 'hidden', name: 'ظاهر' }
        });
        const entry = await AuditLog.findOne({ action: 'SETTINGS_CHANGED' }).lean();
        expect(String(entry.tenantId)).toBe(String(tenantA._id));
        expect(entry.newData.otpCode).toBe('[REDACTED]');
        expect(entry.newData.password).toBe('[REDACTED]');
        expect(entry.newData.name).toBe('ظاهر');
        expect(entry.hash).toBe(calculateHash(entry, entry.previousHash));
    });

    test('legacy tenant backfill dry-run reports confident, ambiguous, and unresolvable rows', async () => {
        const company = await ClientCompany.create({
            name: 'شركة موثوقة',
            tenantId: tenantA._id,
            balance: 50,
            status: 'active'
        });
        const sub = await SubAccount.create({
            masterType: 'company',
            masterId: company._id,
            name: 'نقطة غامضة',
            webUsername: 'safety-sub-amb',
            webPassword: 'secret123',
            tenantId: tenantB._id,
            balance: 7,
            status: 'active'
        });
        await Transaction.create({
            customId: 'LEG-OK-1',
            amount: 15,
            status: 'completed',
            companyId: company._id,
            userId: userA.phone
        });
        await Transaction.create({
            customId: 'LEG-AMB-1',
            amount: 10,
            status: 'pending',
            companyId: company._id,
            subAccountId: sub._id,
            userId: 'ghost-ambiguous'
        });
        await Transaction.create({
            customId: 'LEG-NO-1',
            amount: 4,
            status: 'pending',
            userId: 'ghost-user-xyz'
        });
        await Ledger.create({
            entityId: userB._id,
            entityModel: 'User',
            transactionId: 'LEG-OK-1',
            type: 'TRANSFER',
            amount: -1,
            balanceBefore: 10,
            balanceAfter: 9,
            description: 'تعارض منظمة القيد مع منظمة العملية'
        });
        await Ledger.create({
            entityId: userA._id,
            entityModel: 'User',
            transactionId: 'MISSING-TX-SAFETY',
            type: 'DEPOSIT',
            amount: 5,
            balanceBefore: 1,
            balanceAfter: 6,
            description: 'قيد قديم بلا عملية'
        });
        await JournalEvent.create({
            eventType: 'MoneyDeposited',
            entityId: new mongoose.Types.ObjectId(),
            entityModel: 'User',
            amount: 1,
            currency: 'EGP',
            sequenceNumber: 1,
            metadata: {}
        });
        await AuditLog.create({ action: 'USER_CREATED', companyId: company._id, performedByName: 'نظام' });
        await AuditLog.create({ action: 'LOGIN_FAILED', performedByName: 'مجهول' });

        const companyBalance = (await ClientCompany.findById(company._id)).balance;
        const userBalance = (await User.findById(userA._id)).balance;
        const report = await runBackfill({
            apply: false,
            User,
            ClientCompany,
            SubAccount,
            Transaction,
            Ledger,
            JournalEvent,
            AuditLog
        });
        expect(report.mode).toBe('dry-run');
        expect(report.collections.Transaction.summary.confident).toBeGreaterThanOrEqual(1);
        expect(report.collections.Transaction.summary.ambiguous).toBeGreaterThanOrEqual(1);
        expect(report.collections.Transaction.summary.unresolvable).toBeGreaterThanOrEqual(1);
        expect(report.collections.Ledger.summary.ambiguous).toBeGreaterThanOrEqual(1);
        expect(report.collections.Ledger.summary.confident).toBeGreaterThanOrEqual(1);
        expect(report.collections.JournalEvent.summary.unresolvable).toBeGreaterThanOrEqual(1);
        expect(report.collections.AuditLog.summary.confident).toBeGreaterThanOrEqual(1);
        expect(report.collections.AuditLog.summary.unresolvable).toBeGreaterThanOrEqual(1);
        expect((await ClientCompany.findById(company._id)).balance).toBe(companyBalance);
        expect((await User.findById(userA._id)).balance).toBe(userBalance);
        expect((await Transaction.findOne({ customId: 'LEG-OK-1' })).tenantId || null).toBeNull();

        const reportDir = path.join(__dirname, '..', 'docs', 'financial-safety');
        fs.mkdirSync(reportDir, { recursive: true });
        fs.writeFileSync(path.join(reportDir, 'migration-dry-run-report.json'), JSON.stringify(report, null, 2));

        const applied = await runBackfill({
            apply: true,
            User,
            ClientCompany,
            SubAccount,
            Transaction,
            Ledger,
            JournalEvent,
            AuditLog
        });
        expect(String((await Transaction.findOne({ customId: 'LEG-OK-1' })).tenantId)).toBe(String(tenantA._id));
        expect((await Transaction.findOne({ customId: 'LEG-AMB-1' })).tenantId || null).toBeNull();
        expect((await Transaction.findOne({ customId: 'LEG-NO-1' })).tenantId || null).toBeNull();
        expect((await ClientCompany.findById(company._id)).balance).toBe(companyBalance);
        expect((await Transaction.findOne({ customId: 'LEG-OK-1' })).amount).toBe(15);
        expect((await Transaction.findOne({ customId: 'LEG-OK-1' })).status).toBe('completed');
        expect(applied.collections.Transaction.summary.modified).toBeGreaterThanOrEqual(1);

        const indexReport = await runPrepare({
            apply: false,
            allowIndex: false,
            AccountCode,
            User,
            ClientCompany,
            SubAccount
        });
        expect(indexReport.indexCreated).toBe(false);
        expect(indexReport.mode).toBe('scan');
    });
});
