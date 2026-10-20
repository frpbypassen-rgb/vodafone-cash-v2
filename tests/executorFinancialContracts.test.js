'use strict';

process.env.NODE_ENV = 'test';
process.env.BULLMQ_WORKERS_ENABLED = 'false';
process.env.EXTERNAL_API_ENABLED = 'false';
process.env.WHATCHIMP_ENABLED = 'false';
process.env.REDIS_ENABLED = 'false';
process.env.JWT_SECRET = process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32
    ? process.env.JWT_SECRET
    : 'executor-financial-contract-test-jwt-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET && process.env.JWT_REFRESH_SECRET.length >= 32
    ? process.env.JWT_REFRESH_SECRET
    : 'executor-financial-contract-test-refresh-secret';
delete process.env.REDIS_URL;
delete process.env.REDIS_URI;
delete process.env.ALLOW_LEGACY_SAME_ORIGIN_CSRF;

jest.mock('../services/zaynpayApi', () => ({
    inquiry: jest.fn(),
    pay: jest.fn()
}));

jest.mock('../services/whatsappReceiptDeliveryService', () => ({
    sendCompletedTransactionReceipt: jest.fn(async () => ({ success: true })),
    sendCancelledTransactionReceipt: jest.fn(async () => ({ success: true }))
}));

jest.mock('../utils/manualExecutorReceipt', () => {
    const actual = jest.requireActual('../utils/manualExecutorReceipt');
    const tiny = 'data:image/jpeg;base64,AAECAwQ=';
    return {
        ...actual,
        generateExecutorReceiptBase64: jest.fn(() => tiny),
        generateManualExecutorReceiptBase64: jest.fn(async () => tiny)
    };
});

const fs = require('fs');
const path = require('path');

const Admin = require('../models/Admin');
const AgencyJournal = require('../models/AgencyJournal');
const AuditLog = require('../models/AuditLog');
const ClientCompany = require('../models/ClientCompany');
const Counter = require('../models/Counter');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const Ledger = require('../models/Ledger');
const Notification = require('../models/Notification');
const SubAccount = require('../models/SubAccount');
const Tenant = require('../models/Tenant');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { clearExecutorAuthCache } = require('../services/executorAuthCache');
const zaynpay = require('../services/zaynpayApi');
const whatsapp = require('../services/whatsappReceiptDeliveryService');
const {
    AMOUNT,
    COMMISSION,
    COST,
    OPENING_BALANCE,
    POOL_DEPOSIT,
    PROOFS_DIR,
    RATE,
    SESSION_ENDED,
    TASK_FORBIDDEN,
    TINY_PNG,
    buildApp,
    createBarrier,
    ensureIndexes,
    id,
    postJson,
    removeProofs,
    serviceBalance,
    stableBody,
    startMemoryMongo,
    stopMemoryMongo,
    waitFor
} = require('./helpers/executorFinancialHarness');

jest.setTimeout(180000);

const UNRESOLVED_ERROR = 'لا يمكن إلغاء العملية مع الاسترجاع: نتيجة المزود غير محسومة. يجب مراجعتها يدوياً قبل أي استرجاع أو إعادة إرسال.';

describe('executor portal financial contracts', () => {
    let app;
    let tenantA;
    let tenantB;
    let parent;
    let group;
    let otherGroup;
    let zaynParent;
    let zaynGroup;
    let operator;
    let operator2;
    let accountant;
    let manager;
    let zaynEmployee;
    let outsider;
    let user;
    let company;
    let subAccount;
    let admin;

    const reloadUser = () => User.findById(user._id).lean();
    const reloadCompany = () => ClientCompany.findById(company._id).lean();
    const reloadGroup = () => ExecutorGroup.findById(group._id).lean();
    const reloadParent = () => ExecutorGroup.findById(parent._id).lean();
    const reloadSub = () => SubAccount.findById(subAccount._id).lean();
    const reloadTx = (txId) => Transaction.findById(txId);

    const baseMoney = async () => ({
        user: (await reloadUser()).balance,
        company: (await reloadCompany()).balance,
        sub: (await reloadSub()).balance,
        group: (await reloadGroup()).balance,
        parent: (await reloadParent()).balance,
        ledger: await Ledger.countDocuments(),
        audit: await AuditLog.countDocuments(),
        notifications: await Notification.countDocuments(),
        agency: await AgencyJournal.countDocuments()
    });

    const createTask = (overrides = {}) => Transaction.create({
        customId: `EXECFIN-${id()}`,
        amount: AMOUNT,
        costLYD: COST,
        exchangeRate: RATE,
        commission: COMMISSION,
        status: 'processing',
        transferType: 'vodafone',
        vodafoneNumber: '01000000000',
        userId: user.phone,
        executorGroupId: group._id,
        tenantId: tenantA._id,
        companyName: 'عميل فردي',
        employeeName: 'عميل التوصيف',
        ...overrides
    });

    const seedDeposit = (targetGroup, amount = POOL_DEPOSIT) => Transaction.create({
        customId: `EXECFIN-DEP-${id()}`,
        amount,
        costLYD: 0,
        commission: 0,
        exchangeRate: 0,
        status: 'deposit',
        transferType: 'vodafone',
        executorGroupId: targetGroup._id,
        userId: 'admin',
        tenantId: targetGroup.tenantId
    });

    const accept = (tx, employee = operator) => postJson(
        app,
        `/executor-portal/api/accept-task/${tx._id}`,
        {},
        { employee }
    );

    const edit = (tx, newAmount, employee = operator, reason = 'تصحيح توصيف') => postJson(
        app,
        `/executor-portal/api/edit-amount/${tx._id}`,
        { newAmount, reason },
        { employee }
    );

    const cancel = (tx, employee = operator, reason = 'رقم غير صحيح') => postJson(
        app,
        `/executor-portal/api/cancel-task/${tx._id}`,
        { reason },
        { employee }
    );

    const complete = (tx, body = { executionNumber: '2258' }, employee = operator) => postJson(
        app,
        `/executor-portal/api/complete-task/${tx._id}`,
        body,
        { employee }
    );

    beforeAll(async () => {
        await startMemoryMongo();
        await ensureIndexes([
            Tenant, User, ClientCompany, SubAccount, Employee, ExecutorGroup,
            Transaction, Ledger, AuditLog, Notification, Counter, Admin, AgencyJournal
        ]);

        tenantA = await Tenant.create({ name: 'شركة التوصيف أ', slug: 'exec-fin-a', status: 'active' });
        tenantB = await Tenant.create({ name: 'شركة التوصيف ب', slug: 'exec-fin-b', status: 'active' });
        parent = await ExecutorGroup.create({
            name: 'مجموعة الأب',
            status: 'active',
            balance: 8000,
            isManagerGroup: true,
            manualReceiptPrefix: '801',
            tenantId: tenantA._id,
            serviceKey: 'vodafone'
        });
        group = await ExecutorGroup.create({
            name: 'مجموعة التنفيذ',
            status: 'active',
            balance: POOL_DEPOSIT,
            manualReceiptPrefix: '321',
            parentGroupId: parent._id,
            tenantId: tenantA._id,
            manualProofRequired: false,
            manualTaskRoutingEnabled: false,
            serviceKey: 'vodafone'
        });
        otherGroup = await ExecutorGroup.create({
            name: 'مجموعة أخرى',
            status: 'active',
            balance: 700,
            manualReceiptPrefix: '322',
            tenantId: tenantB._id,
            serviceKey: 'vodafone'
        });
        zaynParent = await ExecutorGroup.create({
            name: 'أب زين',
            status: 'active',
            balance: 9000,
            isManagerGroup: true,
            manualReceiptPrefix: '655',
            tenantId: tenantA._id,
            serviceKey: 'vodafone'
        });
        zaynGroup = await ExecutorGroup.create({
            name: 'مجموعة زين',
            status: 'active',
            balance: POOL_DEPOSIT,
            manualReceiptPrefix: '654',
            parentGroupId: zaynParent._id,
            tenantId: tenantA._id,
            serviceKey: 'vodafone'
        });

        const employeeBase = {
            status: 'active',
            webPassword: 'secret-pass-123',
            tenantId: tenantA._id
        };
        operator = await Employee.create({
            ...employeeBase,
            name: 'منفذ التوصيف',
            role: 'operator',
            groupId: group._id,
            webUsername: 'exec-fin-operator'
        });
        operator2 = await Employee.create({
            ...employeeBase,
            name: 'منفذ ثان',
            role: 'operator',
            groupId: group._id,
            webUsername: 'exec-fin-operator-2'
        });
        accountant = await Employee.create({
            ...employeeBase,
            name: 'محاسب التنفيذ',
            role: 'accountant',
            groupId: group._id,
            webUsername: 'exec-fin-accountant'
        });
        manager = await Employee.create({
            ...employeeBase,
            name: 'مدير التنفيذ',
            role: 'manager',
            groupId: group._id,
            webUsername: 'exec-fin-manager'
        });
        zaynEmployee = await Employee.create({
            ...employeeBase,
            name: 'منفذ زين',
            role: 'operator',
            groupId: zaynGroup._id,
            webUsername: 'zaynapi@ahram.com'
        });
        outsider = await Employee.create({
            ...employeeBase,
            name: 'منفذ خارج المجموعة',
            role: 'operator',
            groupId: otherGroup._id,
            tenantId: tenantB._id,
            webUsername: 'exec-fin-outsider'
        });
        user = await User.create({
            name: 'عميل التوصيف',
            webUsername: 'exec-fin-user',
            webPassword: 'secret-pass-123',
            phone: '01091110001',
            balance: OPENING_BALANCE,
            creditLimit: 0,
            status: 'active',
            tenantId: tenantA._id
        });
        company = await ClientCompany.create({
            name: 'شركة التوصيف',
            phone: '01091110002',
            balance: OPENING_BALANCE,
            creditLimit: 0,
            accountCode: 'EXECFINCO',
            status: 'active',
            tenantId: tenantA._id
        });
        subAccount = await SubAccount.create({
            masterType: 'user',
            masterId: user._id,
            name: 'حساب فرعي',
            webUsername: 'exec-fin-sub',
            webPassword: 'secret-pass-123',
            balance: 80,
            tenantId: tenantA._id
        });
        admin = await Admin.create({
            name: 'مراجع التوصيف',
            webUsername: 'exec-fin-admin',
            webPassword: 'secret-pass-123',
            role: 'admin'
        });
        app = buildApp();
    });

    afterAll(async () => {
        if (fs.existsSync(PROOFS_DIR)) {
            for (const name of fs.readdirSync(PROOFS_DIR)) {
                if (name.startsWith('EXECFIN')) fs.unlinkSync(path.join(PROOFS_DIR, name));
            }
        }
        await stopMemoryMongo();
    });

    beforeEach(async () => {
        jest.clearAllMocks();
        zaynpay.inquiry.mockResolvedValue({ billId: 'BILL-FIXED' });
        zaynpay.pay.mockResolvedValue({
            success: true,
            refNumber: 'REF-FIXED-1000',
            transactionNumber: 'ZTX-FIXED-1000'
        });
        whatsapp.sendCompletedTransactionReceipt.mockResolvedValue({ success: true });
        whatsapp.sendCancelledTransactionReceipt.mockResolvedValue({ success: true });
        clearExecutorAuthCache();
        process.env.EXTERNAL_API_ENABLED = 'false';
        await Promise.all([
            Transaction.deleteMany({}),
            Ledger.deleteMany({}),
            AuditLog.deleteMany({}),
            Notification.deleteMany({}),
            AgencyJournal.deleteMany({})
        ]);
        await Promise.all([
            User.updateOne({ _id: user._id }, { $set: { balance: OPENING_BALANCE, creditLimit: 0 } }),
            ClientCompany.updateOne({ _id: company._id }, { $set: { balance: OPENING_BALANCE, creditLimit: 0 } }),
            SubAccount.updateOne({ _id: subAccount._id }, { $set: { balance: 80 } }),
            ExecutorGroup.updateOne({ _id: group._id }, { $set: { balance: POOL_DEPOSIT, manualTaskRoutingEnabled: false, manualProofRequired: false }, $unset: { serviceBalances: 1 } }),
            ExecutorGroup.updateOne({ _id: parent._id }, { $set: { balance: 8000 }, $unset: { serviceBalances: 1 } }),
            ExecutorGroup.updateOne({ _id: otherGroup._id }, { $set: { balance: 700 }, $unset: { serviceBalances: 1 } }),
            ExecutorGroup.updateOne({ _id: zaynGroup._id }, { $set: { balance: POOL_DEPOSIT, parentGroupId: zaynParent._id }, $unset: { serviceBalances: 1 } }),
            ExecutorGroup.updateOne({ _id: zaynParent._id }, { $set: { balance: 9000 }, $unset: { serviceBalances: 1 } })
        ]);
        if (fs.existsSync(PROOFS_DIR)) {
            for (const name of fs.readdirSync(PROOFS_DIR)) {
                if (name.startsWith('EXECFIN')) fs.unlinkSync(path.join(PROOFS_DIR, name));
            }
        }
    });

    test('accept claims a processing task without moving money', async () => {
        const tx = await createTask();
        const before = await baseMoney();

        const response = await accept(tx);

        const stored = await reloadTx(tx._id);
        const after = await baseMoney();
        expect(response.status).toBe(200);
        expect(stableBody(response.body)).toEqual({
            success: true,
            code: null,
            error: null,
            message: null,
            newAmount: null,
            replayed: false,
            transactionNumber: null
        });
        expect(stored.status).toBe('accepted');
        expect(stored.amount).toBe(AMOUNT);
        expect(stored.costLYD).toBe(COST);
        expect(stored.commission).toBe(COMMISSION);
        expect(stored.exchangeRate).toBe(RATE);
        expect(String(stored.operatorId)).toBe(String(operator._id));
        expect(stored.executorName).toBe('منفذ التوصيف');
        expect(after).toEqual(before);
        expect(zaynpay.inquiry).not.toHaveBeenCalled();
        expect(zaynpay.pay).not.toHaveBeenCalled();
    });

    test('a second accept by the same executor is a replay and does not publish another claim', async () => {
        const tx = await createTask();
        await accept(tx);
        const eventBus = require('../services/eventBus');
        const published = jest.spyOn(eventBus, 'publish');

        const response = await accept(tx);

        expect(response.status).toBe(200);
        expect(stableBody(response.body).replayed).toBe(true);
        expect(published).not.toHaveBeenCalled();
        expect(await Transaction.countDocuments({ status: 'accepted', operatorId: String(operator._id) })).toBe(1);
        expect((await reloadUser()).balance).toBe(OPENING_BALANCE);
        published.mockRestore();
    });

    test('concurrent accepts from one executor leave a single claim', async () => {
        const tx = await createTask();

        const [first, second] = await Promise.all([accept(tx), accept(tx)]);
        const statuses = [first.status, second.status].sort();
        const stored = await reloadTx(tx._id);
        const failure = [first, second].find((item) => item.status === 500);

        expect(statuses).toEqual([200, 500]);
        expect(failure.body).toEqual({ success: false, error: 'تعذر سحب العملية.' });
        expect(stored.status).toBe('accepted');
        expect(String(stored.operatorId)).toBe(String(operator._id));
        expect(await Transaction.countDocuments({ _id: tx._id, status: 'accepted' })).toBe(1);
        expect((await reloadUser()).balance).toBe(OPENING_BALANCE);
        expect(await Ledger.countDocuments()).toBe(0);
    });

    test('two executors cannot both claim the same task', async () => {
        const tx = await createTask();

        const [first, second] = await Promise.all([
            accept(tx, operator),
            accept(tx, operator2)
        ]);
        const bodies = [stableBody(first.body), stableBody(second.body)];
        const winner = bodies.find((body) => body.success === true);
        const loser = bodies.find((body) => body.success === false);
        const stored = await reloadTx(tx._id);

        expect(winner).toEqual(expect.objectContaining({ success: true, replayed: false }));
        expect(loser).toEqual(expect.objectContaining({
            success: false,
            code: 'TASK_TAKEN'
        }));
        expect([first.status, second.status].sort()).toEqual([200, 409]);
        expect(stored.status).toBe('accepted');
        expect([String(operator._id), String(operator2._id)]).toContain(String(stored.operatorId));
        expect(await Transaction.countDocuments({ status: 'accepted' })).toBe(1);
        expect((await reloadGroup()).balance).toBe(POOL_DEPOSIT);
    });

    test('an executor with an open claim cannot accept a second task', async () => {
        const first = await createTask();
        const second = await createTask();
        await accept(first);

        const response = await accept(second);

        expect(response.status).toBe(409);
        expect(stableBody(response.body)).toEqual(expect.objectContaining({
            success: false,
            code: 'ACTIVE_TASK_EXISTS',
            error: 'أكمل أو ألغِ العملية الحالية قبل قبول أو توجيه عملية أخرى.'
        }));
        expect((await reloadTx(second._id)).status).toBe('processing');
        expect((await reloadUser()).balance).toBe(OPENING_BALANCE);
    });

    test('a task from another group is rejected and a task from another tenant in the same group is accepted', async () => {
        const foreignGroup = await createTask({ executorGroupId: otherGroup._id, tenantId: tenantB._id });
        const foreignTenant = await createTask({ tenantId: tenantB._id });

        const groupResponse = await accept(foreignGroup);
        const tenantResponse = await accept(foreignTenant);

        expect(groupResponse.status).toBe(409);
        expect(stableBody(groupResponse.body).code).toBe('TASK_GROUP_MISMATCH');
        expect((await reloadTx(foreignGroup._id)).status).toBe('processing');
        // CURRENT BEHAVIOR (suspected issue): portal accept does not receive tenantId,
        // so a task stamped with another tenant is claimed when the group matches.
        expect(tenantResponse.status).toBe(200);
        expect(stableBody(tenantResponse.body).success).toBe(true);
        expect((await reloadTx(foreignTenant._id)).status).toBe('accepted');
        expect((await reloadUser()).balance).toBe(OPENING_BALANCE);
        expect(await Ledger.countDocuments()).toBe(0);
    });

    test('accountant, logged-out session, missing CSRF, and routed manager cannot accept', async () => {
        const tx = await createTask();
        const before = await baseMoney();

        const accountantResponse = await accept(tx, accountant);
        const loggedOut = await postJson(app, `/executor-portal/api/accept-task/${tx._id}`, {}, { auth: 'none' });
        const missingCsrf = await postJson(
            app,
            `/executor-portal/api/accept-task/${tx._id}`,
            {},
            { employee: operator, csrf: false }
        );
        await ExecutorGroup.updateOne({ _id: group._id }, { manualTaskRoutingEnabled: true });
        const managerResponse = await accept(tx, manager);
        await ExecutorGroup.updateOne({ _id: group._id }, { manualTaskRoutingEnabled: false });

        expect(accountantResponse.status).toBe(403);
        expect(accountantResponse.body).toEqual({ success: false, error: TASK_FORBIDDEN });
        expect(loggedOut.status).toBe(401);
        expect(loggedOut.body).toEqual({ success: false, error: SESSION_ENDED });
        expect(missingCsrf.status).toBe(403);
        expect(missingCsrf.body).toEqual({ success: false, error: 'Invalid CSRF token' });
        expect(managerResponse.status).toBe(400);
        expect(stableBody(managerResponse.body).code).toBe('ROUTING_REQUIRED');
        expect((await reloadTx(tx._id)).status).toBe('processing');
        expect(await baseMoney()).toEqual(before);
    });

    test('raising the amount debits the same LYD difference and leaves commission and ledger untouched', async () => {
        const tx = await createTask({ status: 'accepted', operatorId: String(operator._id) });

        const response = await edit(tx, 2500);

        const stored = await reloadTx(tx._id);
        expect(response.status).toBe(200);
        expect(stableBody(response.body)).toEqual({
            success: true,
            code: null,
            error: null,
            message: null,
            newAmount: 2500,
            replayed: null,
            transactionNumber: null
        });
        expect(stored.amount).toBe(2500);
        expect(stored.costLYD).toBe(50);
        expect(stored.exchangeRate).toBe(RATE);
        expect(stored.commission).toBe(COMMISSION);
        expect(stored.status).toBe('accepted');
        expect(stored.adminNotes).toContain('[تعديل المبلغ من 1000 إلى 2500 | السبب: تصحيح توصيف]');
        expect((await reloadUser()).balance).toBe(470);
        expect((await reloadCompany()).balance).toBe(OPENING_BALANCE);
        expect((await reloadGroup()).balance).toBe(POOL_DEPOSIT);
        expect(await Ledger.countDocuments()).toBe(0);
        expect(await AuditLog.countDocuments()).toBe(0);
    });

    test('lowering the amount credits the LYD difference back to the user', async () => {
        const tx = await createTask({ status: 'accepted', operatorId: String(operator._id) });

        const response = await edit(tx, 500);

        const stored = await reloadTx(tx._id);
        expect(response.status).toBe(200);
        expect(response.body.newAmount).toBe(500);
        expect(stored.amount).toBe(500);
        expect(stored.costLYD).toBe(10);
        expect(stored.commission).toBe(COMMISSION);
        expect((await reloadUser()).balance).toBe(510);
        expect(await Ledger.countDocuments()).toBe(0);
    });

    test('a company increase uses the credit-limit check and can drive balance negative', async () => {
        await ClientCompany.updateOne({ _id: company._id }, { balance: 5, creditLimit: 10 });
        const tx = await createTask({
            status: 'accepted',
            operatorId: String(operator._id),
            companyId: company._id,
            userId: user.phone
        });

        const response = await edit(tx, 1600);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: true, newAmount: 1600 });
        expect((await reloadTx(tx._id)).costLYD).toBe(32);
        expect((await reloadCompany()).balance).toBe(-7);
        expect((await reloadUser()).balance).toBe(OPENING_BALANCE);
        expect(await Ledger.countDocuments()).toBe(0);
    });

    test('an increase the wallet cannot cover is rejected with no partial write', async () => {
        await User.updateOne({ _id: user._id }, { balance: 10, creditLimit: 0 });
        const tx = await createTask({ status: 'accepted', operatorId: String(operator._id) });

        const response = await edit(tx, 2500);

        const stored = await reloadTx(tx._id);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: false, error: 'رصيد العميل لا يكفي لتغطية الزيادة' });
        expect(stored.amount).toBe(AMOUNT);
        expect(stored.costLYD).toBe(COST);
        expect((await reloadUser()).balance).toBe(10);
        expect(await Ledger.countDocuments()).toBe(0);
    });

    test('Sefa Niger reprices with source-to-lyd multiplication', async () => {
        const tx = await createTask({
            status: 'accepted',
            operatorId: String(operator._id),
            transferType: 'sefa_niger',
            amount: 100,
            costLYD: 25,
            exchangeRate: 0.25
        });

        const response = await edit(tx, 40);

        const stored = await reloadTx(tx._id);
        expect(response.body).toEqual({ success: true, newAmount: 40 });
        expect(stored.amount).toBe(40);
        expect(stored.costLYD).toBe(10);
        expect(stored.commission).toBe(COMMISSION);
        expect((await reloadUser()).balance).toBe(515);
    });

    test('repeating the same amount does not debit twice', async () => {
        const tx = await createTask({ status: 'accepted', operatorId: String(operator._id) });
        await edit(tx, 2500);

        const response = await edit(tx, 2500);

        const stored = await reloadTx(tx._id);
        expect(response.body.newAmount).toBe(2500);
        expect(stored.costLYD).toBe(50);
        expect((stored.adminNotes.match(/تعديل المبلغ من 2500 إلى 2500/g) || []).length).toBe(1);
        expect((await reloadUser()).balance).toBe(470);
        expect(await Ledger.countDocuments()).toBe(0);
    });

    test('concurrent edits both apply the original difference', async () => {
        const tx = await createTask({ status: 'accepted', operatorId: String(operator._id) });
        const barrier = createBarrier(2);
        const original = User.findOneAndUpdate;
        const spy = jest.spyOn(User, 'findOneAndUpdate').mockImplementation(async function barrierUpdate(...args) {
            await barrier.enter();
            return original.apply(this, args);
        });

        try {
            const [first, second] = await Promise.all([edit(tx, 2000), edit(tx, 2000)]);
            const stored = await reloadTx(tx._id);
            // CURRENT BEHAVIOR (suspected issue): both requests read cost 20 and each debit 20.
            expect(first.body.success).toBe(true);
            expect(second.body.success).toBe(true);
            expect(stored.amount).toBe(2000);
            expect(stored.costLYD).toBe(40);
            expect((await reloadUser()).balance).toBe(460);
            expect(await Ledger.countDocuments()).toBe(0);
        } finally {
            spy.mockRestore();
        }
    });

    test('a funding credit in flight is added to the edit debit', async () => {
        const tx = await createTask({ status: 'accepted', operatorId: String(operator._id) });

        const [response] = await Promise.all([
            edit(tx, 2000),
            User.updateOne({ _id: user._id }, { $inc: { balance: 50 } })
        ]);

        expect(response.body).toEqual({ success: true, newAmount: 2000 });
        expect((await reloadTx(tx._id)).costLYD).toBe(40);
        expect((await reloadUser()).balance).toBe(530);
        expect(await Ledger.countDocuments()).toBe(0);
    });

    test('a failed save after the debit leaves the new balance and the old amount', async () => {
        const tx = await createTask({ status: 'accepted', operatorId: String(operator._id) });
        const spy = jest.spyOn(Transaction.prototype, 'save').mockRejectedValueOnce(new Error('forced-save-failure'));

        try {
            const response = await edit(tx, 2500);
            const stored = await reloadTx(tx._id);
            // CURRENT BEHAVIOR (suspected issue): balance moves before save and there is no transaction rollback.
            expect(response.status).toBe(200);
            expect(response.body).toEqual({ success: false, error: 'forced-save-failure' });
            expect(stored.amount).toBe(AMOUNT);
            expect(stored.costLYD).toBe(COST);
            expect(stored.status).toBe('accepted');
            expect((await reloadUser()).balance).toBe(470);
            expect(await Ledger.countDocuments()).toBe(0);
        } finally {
            spy.mockRestore();
        }
    });

    test('invalid amount, another executor, accountant, and missing CSRF do not change the edit', async () => {
        const tx = await createTask({ status: 'accepted', operatorId: String(operator._id) });

        const invalid = await edit(tx, 0);
        const other = await edit(tx, 2500, operator2);
        const accountantResponse = await edit(tx, 2500, accountant);
        const missingCsrf = await postJson(
            app,
            `/executor-portal/api/edit-amount/${tx._id}`,
            { newAmount: 2500, reason: 'csrf' },
            { employee: operator, csrf: false }
        );
        const stored = await reloadTx(tx._id);

        expect(invalid.body).toEqual({ success: false, error: 'مبلغ غير صالح' });
        expect(other.status).toBe(200);
        expect(other.body).toEqual({ success: false, error: 'العملية غير صالحة أو لا تملك صلاحية تعديلها' });
        expect(accountantResponse.status).toBe(403);
        expect(accountantResponse.body.error).toBe(TASK_FORBIDDEN);
        expect(missingCsrf.status).toBe(403);
        expect(missingCsrf.body.error).toBe('Invalid CSRF token');
        expect(stored.amount).toBe(AMOUNT);
        expect(stored.costLYD).toBe(COST);
        expect((await reloadUser()).balance).toBe(OPENING_BALANCE);
    });

    test('cancel refunds costLYD, marks the task rejected, and sends one cancellation receipt', async () => {
        const tx = await createTask({
            status: 'accepted',
            operatorId: String(operator._id),
            executorName: 'منفذ التوصيف'
        });

        const response = await cancel(tx);

        const stored = await reloadTx(tx._id);
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: true });
        expect(stored.status).toBe('rejected');
        expect(stored.amount).toBe(AMOUNT);
        expect(stored.costLYD).toBe(COST);
        expect(stored.commission).toBe(COMMISSION);
        expect(stored.cancellationReason).toBe('رقم غير صحيح');
        expect(stored.cancelledBy).toBe('منفذ التوصيف');
        expect(stored.proofImage).toMatch(/_cancellation_receipt\.jpg$/);
        expect(stored.cancellationNumber).toMatch(/^CAN-\d{4}-\d{5}$/);
        expect((await reloadUser()).balance).toBe(520);
        expect((await reloadGroup()).balance).toBe(POOL_DEPOSIT);
        expect(await Ledger.countDocuments()).toBe(0);
        expect(await AgencyJournal.countDocuments()).toBe(0);
        await waitFor(async () => whatsapp.sendCancelledTransactionReceipt.mock.calls.length === 1);
        expect(whatsapp.sendCancelledTransactionReceipt).toHaveBeenCalledTimes(1);
        expect(zaynpay.pay).not.toHaveBeenCalled();
        const notes = await waitFor(async () => {
            const count = await Notification.countDocuments({ userId: admin.webUsername, type: 'system_alert' });
            return count === 1 ? count : 0;
        });
        expect(notes).toBe(1);
        removeProofs(stored.customId);
        removeProofs(stored.cancellationNumber);
    });

    test('a second cancel does not refund again', async () => {
        const tx = await createTask({ status: 'accepted', operatorId: String(operator._id) });
        await cancel(tx);
        await waitFor(async () => whatsapp.sendCancelledTransactionReceipt.mock.calls.length === 1);
        whatsapp.sendCancelledTransactionReceipt.mockClear();

        const response = await cancel(tx);

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: false, error: 'العملية غير صالحة' });
        expect((await reloadUser()).balance).toBe(520);
        expect((await reloadTx(tx._id)).status).toBe('rejected');
        expect(whatsapp.sendCancelledTransactionReceipt).not.toHaveBeenCalled();
        expect(await Ledger.countDocuments()).toBe(0);
    });

    test('concurrent cancels refund costLYD twice', async () => {
        const tx = await createTask({ status: 'accepted', operatorId: String(operator._id) });
        const barrier = createBarrier(2);
        const original = User.findOneAndUpdate;
        const spy = jest.spyOn(User, 'findOneAndUpdate').mockImplementation(async function barrierRefund(...args) {
            await barrier.enter();
            return original.apply(this, args);
        });

        try {
            await Promise.all([cancel(tx), cancel(tx)]);
            // CURRENT BEHAVIOR (suspected issue): both requests pass the accepted check and both $inc the wallet.
            expect((await reloadUser()).balance).toBe(540);
            expect((await reloadTx(tx._id)).status).toBe('rejected');
            expect(await Ledger.countDocuments()).toBe(0);
        } finally {
            spy.mockRestore();
        }
    });

    test.each([
        ['unresolved flag', { providerResultUnresolved: true }],
        ['pending reference', { providerDispatchResult: 'pending_reference' }],
        ['dispatch without a result', {
            providerDispatchStartedAt: new Date('2026-01-01T00:00:00.000Z'),
            providerDispatchAttemptId: 'attempt-fixed'
        }]
    ])('cancel after %s does not refund or resend', async (_label, apiResultData) => {
        const tx = await createTask({
            status: 'accepted',
            operatorId: String(operator._id),
            apiResultData
        });

        const response = await cancel(tx);
        const returned = await postJson(app, `/executor-portal/api/return-task/${tx._id}`, { reason: 'إرجاع' }, { employee: operator });

        const stored = await reloadTx(tx._id);
        expect(response.status).toBe(409);
        expect(stableBody(response.body)).toEqual({
            success: false,
            code: 'PROVIDER_RESULT_UNRESOLVED',
            error: UNRESOLVED_ERROR,
            message: null,
            newAmount: null,
            replayed: null,
            transactionNumber: null
        });
        expect(returned.status).toBe(409);
        expect(returned.body.code).toBe('PROVIDER_RESULT_UNRESOLVED');
        expect(stored.status).toBe('accepted');
        expect(stored.cancellationReason === undefined || stored.cancellationReason === null || stored.cancellationReason === '').toBe(true);
        expect((await reloadUser()).balance).toBe(OPENING_BALANCE);
        expect(whatsapp.sendCancelledTransactionReceipt).not.toHaveBeenCalled();
        expect(zaynpay.inquiry).not.toHaveBeenCalled();
        expect(zaynpay.pay).not.toHaveBeenCalled();
        expect(await Ledger.countDocuments()).toBe(0);
        expect(await Notification.countDocuments()).toBe(0);
    });

    test('a settled provider acceptance still refunds on executor cancel', async () => {
        const tx = await createTask({
            status: 'accepted',
            operatorId: String(operator._id),
            apiResultData: {
                providerDispatchStartedAt: new Date('2026-01-01T00:00:00.000Z'),
                providerDispatchAttemptId: 'attempt-accepted',
                providerDispatchResult: 'accepted'
            }
        });

        const response = await cancel(tx);

        // CURRENT BEHAVIOR (suspected issue): providerDispatchResult accepted does not block the refund.
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: true });
        expect((await reloadTx(tx._id)).status).toBe('rejected');
        expect((await reloadUser()).balance).toBe(520);
        expect(zaynpay.pay).not.toHaveBeenCalled();
    });

    test('cancel save failure keeps the refund and the accepted status', async () => {
        const tx = await createTask({ status: 'accepted', operatorId: String(operator._id) });
        const spy = jest.spyOn(Transaction.prototype, 'save').mockRejectedValueOnce(new Error('forced-save-failure'));

        try {
            const response = await cancel(tx);
            const stored = await reloadTx(tx._id);
            // CURRENT BEHAVIOR (suspected issue): the wallet credit is not rolled back when save fails.
            expect(response.status).toBe(200);
            expect(response.body).toEqual({ success: false, error: 'forced-save-failure' });
            expect(stored.status).toBe('accepted');
            expect(stored.cancellationReason === undefined || stored.cancellationReason === null || stored.cancellationReason === '').toBe(true);
            expect((await reloadUser()).balance).toBe(520);
            expect(whatsapp.sendCancelledTransactionReceipt).not.toHaveBeenCalled();
        } finally {
            spy.mockRestore();
        }
    });

    test('unauthorized cancel and a missing reason leave balances unchanged', async () => {
        const tx = await createTask({ status: 'accepted', operatorId: String(operator._id) });

        const other = await cancel(tx, operator2);
        const outsiderResponse = await cancel(tx, outsider);
        const noReason = await postJson(app, `/executor-portal/api/cancel-task/${tx._id}`, {}, { employee: operator });
        const missingCsrf = await postJson(
            app,
            `/executor-portal/api/cancel-task/${tx._id}`,
            { reason: 'csrf' },
            { employee: operator, csrf: false }
        );

        expect(other.body).toEqual({ success: false, error: 'العملية غير صالحة' });
        expect(outsiderResponse.body).toEqual({ success: false, error: 'العملية غير صالحة' });
        expect(noReason.status).toBe(400);
        expect(noReason.body).toEqual({ success: false, error: 'سبب الإلغاء مطلوب.' });
        expect(missingCsrf.status).toBe(403);
        expect((await reloadTx(tx._id)).status).toBe('accepted');
        expect((await reloadUser()).balance).toBe(OPENING_BALANCE);
        expect(await Ledger.countDocuments()).toBe(0);
    });

    test('returning a task clears the claim and does not refund', async () => {
        const tx = await createTask({
            status: 'accepted',
            operatorId: String(operator._id),
            executorName: 'منفذ التوصيف',
            assignedExecutorId: String(operator._id)
        });

        const response = await postJson(
            app,
            `/executor-portal/api/return-task/${tx._id}`,
            { reason: 'إرجاع للإدارة' },
            { employee: operator }
        );

        const stored = await reloadTx(tx._id);
        expect(response.body).toEqual({ success: true });
        expect(stored.status).toBe('pending');
        expect(stored.operatorId === undefined || stored.operatorId === null).toBe(true);
        expect(stored.executorGroupId === undefined || stored.executorGroupId === null).toBe(true);
        expect((await reloadUser()).balance).toBe(OPENING_BALANCE);
        expect(await Ledger.countDocuments()).toBe(0);
        expect(whatsapp.sendCancelledTransactionReceipt).not.toHaveBeenCalled();
    });

    test('manual completion finalizes one receipt and recomputes the executor pool from source amounts', async () => {
        await seedDeposit(group, POOL_DEPOSIT);
        const tx = await createTask({
            status: 'accepted',
            operatorId: String(operator._id),
            assignedExecutorId: String(operator._id),
            executorName: 'منفذ التوصيف'
        });

        const response = await complete(tx);

        const stored = await reloadTx(tx._id);
        const pool = await reloadGroup();
        const parentPool = await reloadParent();
        expect(response.status).toBe(200);
        expect(stableBody(response.body)).toEqual({
            success: true,
            code: null,
            error: null,
            message: 'تم إنهاء العملية وحفظ الإيصال بنجاح.',
            newAmount: null,
            replayed: null,
            transactionNumber: null
        });
        expect(stored.status).toBe('completed');
        expect(stored.amount).toBe(AMOUNT);
        expect(stored.costLYD).toBe(COST);
        expect(stored.commission).toBe(COMMISSION);
        expect(stored.exchangeRate).toBe(RATE);
        expect(stored.proofImages).toEqual([stored.proofImage]);
        expect(stored.proofImage).toMatch(/^EXECFIN-[a-f0-9]+_manual_[a-z0-9]+\.jpg$/);
        expect(stored.executorProofImages).toEqual([]);
        expect(stored.manualExecutorReceiptReference).toMatch(/^321\d{3}$/);
        expect(stored.executorExecutionNumberMasked).toBe('01*****2258');
        expect(stored.adminNotes).toContain(stored.manualExecutorReceiptReference);
        expect(fs.existsSync(path.join(PROOFS_DIR, stored.proofImage))).toBe(true);
        expect((await reloadUser()).balance).toBe(OPENING_BALANCE);
        expect(pool.balance).toBe(4000);
        expect(serviceBalance(pool, 'vodafone')).toBe(4000);
        // CURRENT BEHAVIOR (suspected issue): parent sync replaces the parent balance from its own rows.
        expect(parentPool.balance).toBe(0);
        expect(await Ledger.countDocuments()).toBe(0);
        const audit = await AuditLog.findOne({ action: 'TRANSFER_COMPLETED', targetId: tx._id }).lean();
        expect(audit.oldData).toEqual({ status: 'accepted' });
        expect(audit.newData.status).toBe('completed');
        expect(audit.newData.proofCount).toBe(1);
        expect(audit.metadata).toEqual(expect.objectContaining({
            customId: stored.customId,
            amount: AMOUNT,
            transferType: 'vodafone'
        }));
        await waitFor(async () => whatsapp.sendCompletedTransactionReceipt.mock.calls.length === 1);
        expect(whatsapp.sendCompletedTransactionReceipt).toHaveBeenCalledTimes(1);
        const note = await waitFor(async () => Notification.findOne({
            userId: user.phone,
            type: 'transfer_complete',
            dedupeKey: `${stored.customId}:${user.phone}:transfer_complete`
        }).lean());
        expect(note.title).toBe('تم إتمام الحوالة بنجاح');
        removeProofs(stored.customId);
    });

    test('a second completion does not debit, receipt, or audit again', async () => {
        await seedDeposit(group, POOL_DEPOSIT);
        const tx = await createTask({
            status: 'accepted',
            operatorId: String(operator._id),
            assignedExecutorId: String(operator._id)
        });
        await complete(tx);
        await waitFor(async () => whatsapp.sendCompletedTransactionReceipt.mock.calls.length === 1);
        const storedOnce = await reloadTx(tx._id);
        whatsapp.sendCompletedTransactionReceipt.mockClear();

        const response = await complete(tx);

        const stored = await reloadTx(tx._id);
        expect(response.status).toBe(409);
        expect(response.body).toEqual({
            success: false,
            error: 'العملية غير متاحة للإنهاء أو تم إنهاؤها مسبقاً.'
        });
        expect(stored.status).toBe('completed');
        expect(stored.proofImage).toBe(storedOnce.proofImage);
        expect(stored.manualExecutorReceiptReference).toBe(storedOnce.manualExecutorReceiptReference);
        expect((await reloadGroup()).balance).toBe(4000);
        expect(await AuditLog.countDocuments({ action: 'TRANSFER_COMPLETED' })).toBe(1);
        expect(whatsapp.sendCompletedTransactionReceipt).not.toHaveBeenCalled();
        expect(await Ledger.countDocuments()).toBe(0);
        removeProofs(stored.customId);
    });

    test('overlapping completion calls produce one completed task and one pool movement', async () => {
        await seedDeposit(group, POOL_DEPOSIT);
        const tx = await createTask({
            status: 'accepted',
            operatorId: String(operator._id),
            assignedExecutorId: String(operator._id)
        });

        const [first, second] = await Promise.all([complete(tx), complete(tx)]);
        const statuses = [first.status, second.status].sort();
        const stored = await reloadTx(tx._id);

        expect(statuses).toEqual([200, 409]);
        expect([first.body.success, second.body.success].sort()).toEqual([false, true]);
        expect(stored.status).toBe('completed');
        expect(stored.proofImages).toHaveLength(1);
        expect((await reloadGroup()).balance).toBe(4000);
        expect(await AuditLog.countDocuments({ action: 'TRANSFER_COMPLETED' })).toBe(1);
        await waitFor(async () => whatsapp.sendCompletedTransactionReceipt.mock.calls.length === 1);
        expect(whatsapp.sendCompletedTransactionReceipt).toHaveBeenCalledTimes(1);
        expect((await reloadUser()).balance).toBe(OPENING_BALANCE);
        removeProofs(stored.customId);
    });

    test('completion save failure deletes the proof file and does not move the pool', async () => {
        const counterName = `manual-executor-receipt-sequence:${group._id}`;
        const beforeCounter = await Counter.findOne({ name: counterName }).lean();
        const tx = await createTask({
            status: 'accepted',
            operatorId: String(operator._id),
            assignedExecutorId: String(operator._id)
        });
        const spy = jest.spyOn(Transaction.prototype, 'save').mockRejectedValueOnce(new Error('forced-save-failure'));

        try {
            const response = await complete(tx);
            const stored = await reloadTx(tx._id);
            const afterCounter = await Counter.findOne({ name: counterName }).lean();
            // CURRENT BEHAVIOR (suspected issue): the receipt sequence is consumed even though save rolls the task back.
            expect(response.status).toBe(500);
            expect(response.body).toEqual({ success: false, error: 'تعذر إنهاء العملية.' });
            expect(stored.status).toBe('accepted');
            expect(stored.proofImage === undefined || stored.proofImage === null || stored.proofImage === '').toBe(true);
            expect((await reloadGroup()).balance).toBe(POOL_DEPOSIT);
            expect((await reloadParent()).balance).toBe(8000);
            expect(await AuditLog.countDocuments()).toBe(0);
            expect(Number(afterCounter.value)).toBe(Number(beforeCounter?.value || 0) + 1);
            expect(whatsapp.sendCompletedTransactionReceipt).not.toHaveBeenCalled();
            const names = fs.existsSync(PROOFS_DIR) ? fs.readdirSync(PROOFS_DIR) : [];
            expect(names.some((name) => name.startsWith(stored.customId))).toBe(false);
        } finally {
            spy.mockRestore();
        }
    });

    test('an uploaded proof stays beside the system receipt', async () => {
        await seedDeposit(group, POOL_DEPOSIT);
        const tx = await createTask({
            status: 'accepted',
            operatorId: String(operator._id),
            assignedExecutorId: String(operator._id)
        });

        const response = await complete(tx, {
            executionNumber: '01012345678',
            imageBase64: TINY_PNG
        });

        const stored = await reloadTx(tx._id);
        expect(response.body.success).toBe(true);
        expect(stored.proofImages).toHaveLength(1);
        expect(stored.proofImage).toMatch(/_manual_.*\.jpg$/);
        expect(stored.executorProofImages).toHaveLength(1);
        expect(stored.executorProofImages[0]).toMatch(/\.png$/);
        expect(stored.executorExecutionNumberMasked).toBe('010****5678');
        expect(fs.existsSync(path.join(PROOFS_DIR, stored.proofImage))).toBe(true);
        expect(fs.existsSync(path.join(PROOFS_DIR, stored.executorProofImages[0]))).toBe(true);
        expect((await reloadGroup()).balance).toBe(4000);
        removeProofs(stored.customId);
    });

    test('invalid or too many proofs do not complete the task', async () => {
        const tx = await createTask({
            status: 'accepted',
            operatorId: String(operator._id),
            assignedExecutorId: String(operator._id)
        });

        const invalid = await complete(tx, { executionNumber: '2258', imageBase64: 'not-an-image' });
        const tooMany = await complete(tx, {
            executionNumber: '2258',
            imagesBase64: [TINY_PNG, TINY_PNG, TINY_PNG, TINY_PNG, TINY_PNG, TINY_PNG]
        });

        expect(invalid.status).toBe(400);
        expect(invalid.body).toEqual({ success: false, error: 'صيغة صورة الإثبات غير صالحة أو حجمها كبير.' });
        expect(tooMany.status).toBe(400);
        expect(tooMany.body).toEqual({ success: false, error: 'الحد الأقصى 5 صور.' });
        expect((await reloadTx(tx._id)).status).toBe('accepted');
        expect((await reloadGroup()).balance).toBe(POOL_DEPOSIT);
        expect((await reloadUser()).balance).toBe(OPENING_BALANCE);
    });

    test('bank completion stores the uploaded proof on the bank service bucket', async () => {
        await seedDeposit(group, POOL_DEPOSIT);
        const tx = await createTask({
            status: 'accepted',
            operatorId: String(operator._id),
            assignedExecutorId: String(operator._id),
            transferType: 'bank_account',
            canonicalServiceKey: 'bank_account'
        });

        const missing = await complete(tx, {});
        const response = await complete(tx, { imageBase64: TINY_PNG });
        const stored = await reloadTx(tx._id);
        const pool = await reloadGroup();

        expect(missing.status).toBe(400);
        expect(missing.body.error).toBe('إرفاق صورة إثبات التحويل البنكي إجباري.');
        expect(response.status).toBe(200);
        expect(response.body.message).toBe('تم إنهاء التحويل البنكي وإرسال إثبات التحويل للعميل.');
        expect(stored.status).toBe('completed');
        expect(stored.manualExecutorReceiptReference === undefined || stored.manualExecutorReceiptReference === null).toBe(true);
        expect(stored.proofImages).toHaveLength(1);
        expect(stored.proofImage).toMatch(/\.png$/);
        expect(stored.adminNotes).toContain('[تم إرفاق إثبات التحويل البنكي وإرساله للعميل]');
        expect(pool.balance).toBe(POOL_DEPOSIT);
        expect(serviceBalance(pool, 'vodafone')).toBe(POOL_DEPOSIT);
        expect(serviceBalance(pool, 'bank_account')).toBe(-AMOUNT);
        expect((await reloadUser()).balance).toBe(OPENING_BALANCE);
        expect(await Ledger.countDocuments()).toBe(0);
        removeProofs(stored.customId);
    });

    test('sub-account completion posts an empty realization and cancel does not reverse it', async () => {
        await seedDeposit(group, POOL_DEPOSIT);
        const tx = await createTask({
            status: 'accepted',
            operatorId: String(operator._id),
            assignedExecutorId: String(operator._id),
            isSubAccountTx: true,
            subAccountId: subAccount._id,
            subAccountCostLYD: 20.833,
            agencyPricing: {
                serviceKey: 'vodafone',
                pricingVersion: 2,
                amountEGP: AMOUNT,
                agentRate: RATE,
                customerRate: 48,
                marginPiasters: 200,
                agentCostLYD: COST,
                customerChargeLYD: 20.833,
                profitLYD: 0.833
            }
        });

        const done = await complete(tx);
        const journal = await waitFor(() => AgencyJournal.findOne({ transactionId: tx.customId }).lean());
        expect(done.body.success).toBe(true);
        expect(journal.eventType).toBe('TRANSFER_REALIZED');
        expect(journal.status).toBe('posted');
        expect(journal.lines).toEqual([]);
        expect(journal.pricing.agentCostLYD).toBe(COST);
        expect(journal.pricing.customerChargeLYD).toBe(20.833);
        expect((await reloadSub()).balance).toBe(80);
        expect((await reloadUser()).balance).toBe(OPENING_BALANCE);

        await Transaction.updateOne({ _id: tx._id }, {
            status: 'accepted',
            operatorId: String(operator._id)
        });
        const cancelled = await cancel(tx);
        // CURRENT BEHAVIOR (suspected issue): portal cancel refunds the user by costLYD and never writes TRANSFER_REVERSED.
        expect(cancelled.body).toEqual({ success: true });
        expect((await reloadUser()).balance).toBe(520);
        expect((await reloadSub()).balance).toBe(80);
        expect(await AgencyJournal.countDocuments({ eventType: 'TRANSFER_REVERSED' })).toBe(0);
        expect(await Ledger.countDocuments()).toBe(0);
        removeProofs((await reloadTx(tx._id)).customId);
    });

    test('another executor, accountant, and missing CSRF cannot complete', async () => {
        const tx = await createTask({
            status: 'accepted',
            operatorId: String(operator._id),
            assignedExecutorId: String(operator._id)
        });

        const other = await complete(tx, { executionNumber: '2258' }, operator2);
        const accountantResponse = await complete(tx, { executionNumber: '2258' }, accountant);
        const missingCsrf = await postJson(
            app,
            `/executor-portal/api/complete-task/${tx._id}`,
            { executionNumber: '2258' },
            { employee: operator, csrf: false }
        );

        expect(other.status).toBe(409);
        expect(other.body.error).toBe('العملية غير متاحة للإنهاء أو تم إنهاؤها مسبقاً.');
        expect(accountantResponse.status).toBe(403);
        expect(missingCsrf.status).toBe(403);
        expect(missingCsrf.body.error).toBe('Invalid CSRF token');
        expect((await reloadTx(tx._id)).status).toBe('accepted');
        expect((await reloadGroup()).balance).toBe(POOL_DEPOSIT);
        expect(await AuditLog.countDocuments()).toBe(0);
    });

    test('ZaynPay stays idle while the external API switch is off', async () => {
        const tx = await createTask({
            status: 'accepted',
            operatorId: String(zaynEmployee._id),
            executorGroupId: zaynGroup._id
        });

        const response = await postJson(app, `/executor-portal/api/zaynpay-execute/${tx._id}`, {}, { employee: zaynEmployee });

        expect(response.status).toBe(200);
        expect(stableBody(response.body)).toEqual({
            success: false,
            code: 'API_EXECUTION_UNAVAILABLE',
            error: 'تنفيذ ZaynPay متوقف. لم يُرسل الطلب إلى المزود ولم يتغير الرصيد.',
            message: null,
            newAmount: null,
            replayed: null,
            transactionNumber: null
        });
        expect(zaynpay.inquiry).not.toHaveBeenCalled();
        expect(zaynpay.pay).not.toHaveBeenCalled();
        expect((await reloadTx(tx._id)).status).toBe('accepted');
        expect((await ExecutorGroup.findById(zaynGroup._id).lean()).balance).toBe(POOL_DEPOSIT);
    });

    test('ZaynPay completion increments pool balances by the negative source amount once', async () => {
        process.env.EXTERNAL_API_ENABLED = 'true';
        const tx = await createTask({
            status: 'accepted',
            operatorId: String(zaynEmployee._id),
            executorGroupId: zaynGroup._id,
            executorName: 'منفذ زين'
        });

        const response = await postJson(app, `/executor-portal/api/zaynpay-execute/${tx._id}`, {}, { employee: zaynEmployee });
        const repeat = await postJson(app, `/executor-portal/api/zaynpay-execute/${tx._id}`, {}, { employee: zaynEmployee });

        const stored = await reloadTx(tx._id);
        const pool = await ExecutorGroup.findById(zaynGroup._id).lean();
        const parentPool = await ExecutorGroup.findById(zaynParent._id).lean();
        expect(response.status).toBe(200);
        expect(stableBody(response.body)).toEqual({
            success: true,
            code: null,
            error: null,
            message: null,
            newAmount: null,
            replayed: null,
            transactionNumber: 'ZTX-FIXED-1000'
        });
        expect(zaynpay.inquiry).toHaveBeenCalledTimes(1);
        expect(zaynpay.inquiry).toHaveBeenCalledWith('01000000000', AMOUNT);
        expect(zaynpay.pay).toHaveBeenCalledTimes(1);
        expect(zaynpay.pay.mock.calls[0][1]).toBe('01000000000');
        expect(zaynpay.pay.mock.calls[0][2]).toBe(AMOUNT);
        expect(stored.status).toBe('completed');
        expect(stored.proofImage).toBe(`${stored.customId}_zaynpay.jpg`);
        expect(stored.proofImages).toEqual([`${stored.customId}_zaynpay.jpg`]);
        expect(stored.notes).toContain('[الرقم المرجعي: REF-FIXED-1000]');
        expect(stored.notes).toContain('[رقم العملية الخارجي: ZTX-FIXED-1000]');
        expect(stored.amount).toBe(AMOUNT);
        expect(stored.costLYD).toBe(COST);
        expect(stored.commission).toBe(COMMISSION);
        // CURRENT BEHAVIOR (suspected issue): $inc applies to balance and an empty service map, so the two fields diverge.
        expect(pool.balance).toBe(4000);
        expect(serviceBalance(pool, 'vodafone')).toBe(-AMOUNT);
        expect(parentPool.balance).toBe(8000);
        expect(serviceBalance(parentPool, 'vodafone')).toBe(-AMOUNT);
        expect(repeat.body).toEqual({ success: false, error: 'الطلب مكتمل مسبقاً' });
        expect(zaynpay.pay).toHaveBeenCalledTimes(1);
        expect(pool.balance).toBe(4000);
        expect(await Ledger.countDocuments()).toBe(0);
        expect(await AuditLog.countDocuments({ action: 'TRANSFER_COMPLETED' })).toBe(0);
        expect(whatsapp.sendCompletedTransactionReceipt).not.toHaveBeenCalled();
        expect(await Notification.countDocuments()).toBe(0);
        expect(fs.existsSync(path.join(PROOFS_DIR, stored.proofImage))).toBe(true);
        removeProofs(stored.customId);
    });

    test('a failed provider payment and a non-Zayn login do not move money', async () => {
        process.env.EXTERNAL_API_ENABLED = 'true';
        zaynpay.pay.mockResolvedValueOnce({ success: false, error: 'رصيد المزود غير كافٍ' });
        const tx = await createTask({
            status: 'accepted',
            executorGroupId: zaynGroup._id
        });

        const failed = await postJson(app, `/executor-portal/api/zaynpay-execute/${tx._id}`, {}, { employee: zaynEmployee });
        const forbidden = await postJson(app, `/executor-portal/api/zaynpay-execute/${tx._id}`, {}, { employee: operator });

        expect(failed.body).toEqual({ success: false, error: 'رصيد المزود غير كافٍ' });
        expect(forbidden.body).toEqual({ success: false, error: 'غير مصرح لك باستخدام بوابة ZaynPay' });
        expect((await reloadTx(tx._id)).status).toBe('accepted');
        expect((await ExecutorGroup.findById(zaynGroup._id).lean()).balance).toBe(POOL_DEPOSIT);
        expect(await Ledger.countDocuments()).toBe(0);
        expect(zaynpay.pay).toHaveBeenCalledTimes(1);
    });

    test('concurrent ZaynPay calls debit the source amount twice', async () => {
        process.env.EXTERNAL_API_ENABLED = 'true';
        await ExecutorGroup.updateOne({ _id: zaynGroup._id }, { $unset: { parentGroupId: 1 } });
        clearExecutorAuthCache();
        const tx = await createTask({
            status: 'accepted',
            executorGroupId: zaynGroup._id
        });
        const barrier = createBarrier(2);
        const original = ExecutorGroup.findByIdAndUpdate;
        const spy = jest.spyOn(ExecutorGroup, 'findByIdAndUpdate').mockImplementation(async function barrierDebit(...args) {
            await barrier.enter();
            return original.apply(this, args);
        });

        try {
            const [first, second] = await Promise.all([
                postJson(app, `/executor-portal/api/zaynpay-execute/${tx._id}`, {}, { employee: zaynEmployee }),
                postJson(app, `/executor-portal/api/zaynpay-execute/${tx._id}`, {}, { employee: zaynEmployee })
            ]);
            const pool = await ExecutorGroup.findById(zaynGroup._id).lean();
            const outcomes = [first.body, second.body];
            // CURRENT BEHAVIOR (suspected issue): both calls pay the provider and both $inc
            // the pool. The second save then throws VersionError, so one response looks
            // failed after the money has already moved twice.
            expect(outcomes.filter((body) => body.success === true)).toHaveLength(1);
            expect(outcomes.filter((body) => body.success === false)[0].error).toMatch(/No matching document found/);
            expect((await reloadTx(tx._id)).status).toBe('completed');
            expect(pool.balance).toBe(3000);
            expect(serviceBalance(pool, 'vodafone')).toBe(-2000);
            expect(zaynpay.pay).toHaveBeenCalledTimes(2);
            expect(await Ledger.countDocuments()).toBe(0);
            expect(await AuditLog.countDocuments()).toBe(0);
        } finally {
            spy.mockRestore();
        }
    });

    test('ZaynPay completes a task owned by another group and debits the Zayn group', async () => {
        process.env.EXTERNAL_API_ENABLED = 'true';
        const tx = await createTask({
            status: 'processing',
            executorGroupId: group._id,
            tenantId: tenantB._id
        });

        const response = await postJson(app, `/executor-portal/api/zaynpay-execute/${tx._id}`, {}, { employee: zaynEmployee });

        const stored = await reloadTx(tx._id);
        const zaynPool = await ExecutorGroup.findById(zaynGroup._id).lean();
        const taskPool = await reloadGroup();
        // CURRENT BEHAVIOR (suspected issue): the portal does not check owner, group, or tenant before paying.
        expect(response.body.success).toBe(true);
        expect(stored.status).toBe('completed');
        expect(String(stored.executorGroupId)).toBe(String(group._id));
        expect(zaynPool.balance).toBe(4000);
        expect(taskPool.balance).toBe(POOL_DEPOSIT);
        expect(await Ledger.countDocuments()).toBe(0);
        removeProofs(stored.customId);
    });
});
