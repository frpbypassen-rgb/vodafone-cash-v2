'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 32
    ? process.env.JWT_SECRET
    : 'split-part-proof-integration-jwt-secret-32';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET && process.env.JWT_REFRESH_SECRET.length >= 32
    ? process.env.JWT_REFRESH_SECRET
    : 'split-part-proof-integration-refresh-secret';

jest.mock('../services/whatsappService', () => {
    const actual = jest.requireActual('../services/whatsappService');
    return {
        ...actual,
        sendReceipt: jest.fn()
    };
});

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const axios = require('axios');
const { createCanvas, loadImage } = require('canvas');
const Transaction = require('../models/Transaction');
const Ledger = require('../models/Ledger');
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const ExecutorGroup = require('../models/ExecutorGroup');
const Employee = require('../models/Employee');
const SubAccount = require('../models/SubAccount');
const ExecutorBalancePool = require('../models/ExecutorBalancePool');
const WhatsAppDelivery = require('../models/WhatsAppDelivery');
const { sendReceipt } = require('../services/whatsappService');
const manualExecutorReceipt = require('../utils/manualExecutorReceipt');
const { preparePersistedSenderEntries } = require('../utils/splitPartProofs');
const { issueSplitPartProofs, retrySplitPartProof } = require('../services/splitPartProofService');
const adminTransactions = require('../routes/adminTransactions');
const executorPortal = require('../routes/executorPortal');
const mobileApi = require('../routes/mobileApi');

jest.setTimeout(180000);

const RECIPIENT = '01055550099';
const WALLET_A = '01108172258';
const WALLET_B = '01000926306';
const CUSTOMER_WHATSAPP = '01000001111';
const CONFIRMED_AT = new Date('2026-09-26T09:15:00.000Z');
const ARTIFACT_DIR = path.join(__dirname, '..', 'artifacts', 'split-part-proofs');
const PROOF_DIR = path.join(process.cwd(), 'uploads', 'proofs');

let replSet;
let axiosPost;
let company;
let user;
let group;
let pool;
let subAccount;
let employee;
let tenantId;
let sequence = 0;
const savedEnv = {};

const rememberEnv = (name, value) => {
    if (!Object.prototype.hasOwnProperty.call(savedEnv, name)) savedEnv[name] = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
};

const restoreEnv = () => {
    Object.entries(savedEnv).forEach(([name, value]) => {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    });
};

const plainMap = (value) => {
    if (!value) return {};
    if (value instanceof Map) return Object.fromEntries(value.entries());
    return { ...value };
};

const financeSnapshot = async () => {
    const [users, companies, groups, employees, subs, pools, ledgers, transactions] = await Promise.all([
        User.find({}).select('balance').lean(),
        ClientCompany.find({}).select('balance').lean(),
        ExecutorGroup.find({}).select('balance serviceBalances').lean(),
        Employee.find({}).select('balance').lean(),
        SubAccount.find({}).select('balance').lean(),
        ExecutorBalancePool.find({}).select('balance').lean(),
        Ledger.find({}).select('entityModel type amount originalAmount balanceBefore balanceAfter transactionId').lean(),
        Transaction.find({}).select('customId amount costLYD commission status companyId executorGroupId').lean()
    ]);
    const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
    const byId = (rows, map) => rows
        .map(map)
        .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const customerDebitRows = ledgers.filter((row) => row.entityModel === 'ClientCompany' && row.type === 'DEDUCTION');
    const executorRows = ledgers.filter((row) => row.entityModel === 'ExecutorGroup');
    return JSON.stringify({
        wallets: {
            users: byId(users, (row) => ({ id: String(row._id), balance: row.balance })),
            companies: byId(companies, (row) => ({ id: String(row._id), balance: row.balance })),
            groups: byId(groups, (row) => ({
                id: String(row._id),
                balance: row.balance,
                serviceBalances: plainMap(row.serviceBalances)
            })),
            employees: byId(employees, (row) => ({ id: String(row._id), balance: row.balance })),
            subAccounts: byId(subs, (row) => ({ id: String(row._id), balance: row.balance })),
            pools: byId(pools, (row) => ({ id: String(row._id), balance: row.balance }))
        },
        ledger: {
            count: ledgers.length,
            amountSum: sum(ledgers, 'amount'),
            originalAmountSum: sum(ledgers, 'originalAmount')
        },
        transactionCount: transactions.length,
        transactions: transactions
            .map((row) => ({
                customId: row.customId,
                amount: row.amount,
                costLYD: row.costLYD,
                commission: row.commission,
                status: row.status
            }))
            .sort((left, right) => String(left.customId).localeCompare(String(right.customId))),
        customerDebit: {
            companyBalance: companies.reduce((total, row) => total + Number(row.balance || 0), 0),
            userBalance: users.reduce((total, row) => total + Number(row.balance || 0), 0),
            deductionCount: customerDebitRows.length,
            deductionSum: sum(customerDebitRows, 'amount')
        },
        executorLedger: {
            groupBalance: groups.reduce((total, row) => total + Number(row.balance || 0), 0),
            rowCount: executorRows.length,
            amountSum: sum(executorRows, 'amount')
        }
    });
};

const paymentCalls = () => (axiosPost?.mock.calls || []).filter(([url]) => /payment/i.test(String(url)));

const withStableFinance = async (run) => {
    const before = await financeSnapshot();
    const transactionsBefore = JSON.parse(before).transactionCount;
    const paymentsBefore = paymentCalls().length;
    const result = await run();
    expect(await financeSnapshot()).toBe(before);
    expect(JSON.parse(await financeSnapshot()).transactionCount).toBe(transactionsBefore);
    expect(paymentCalls()).toHaveLength(paymentsBefore);
    expect(paymentCalls()).toHaveLength(0);
    return result;
};

const proofFile = (imageId) => path.join(process.cwd(), 'uploads', imageId);

const fileHash = (imageId) => crypto.createHash('sha256').update(fs.readFileSync(proofFile(imageId))).digest('hex');

const seedTransfer = async ({
    customId,
    tenant,
    proofStatus = 'pending',
    imageId = null
} = {}) => {
    sequence += 1;
    const id = new mongoose.Types.ObjectId();
    const reference = customId || `TEST-REF-SPLIT-${sequence}`;
    const entries = preparePersistedSenderEntries({
        transactionId: id,
        completedAt: CONFIRMED_AT,
        entries: [
            { phone: WALLET_A, amount: 1000, proofImage: null },
            { phone: WALLET_B, amount: 1500, proofImage: null }
        ]
    }).map((entry) => {
        if (!imageId && proofStatus === 'pending') return entry;
        return {
            ...entry,
            customerProof: {
                ...entry.customerProof,
                status: proofStatus,
                imageId,
                attempts: imageId ? 1 : 0
            }
        };
    });
    return Transaction.create({
        _id: id,
        customId: reference,
        status: 'completed',
        transferType: 'vodafone',
        amount: 2500,
        costLYD: 175.5,
        commission: 6.25,
        vodafoneNumber: RECIPIENT,
        userId: CUSTOMER_WHATSAPP,
        companyId: company._id,
        executorGroupId: group._id,
        completedAt: CONFIRMED_AT,
        executorSenderEntries: entries,
        proofImages: [],
        tenantId: tenant
    });
};

const part = (tx, partId) => tx.executorSenderEntries.find((entry) => entry.partId === partId);

const executorApp = express();
executorApp.use(express.json());
executorApp.use((req, _res, next) => {
    req.session = {
        isExecutorLoggedIn: true,
        executorId: String(employee?._id || ''),
        executorGroupId: String(group?._id || '')
    };
    next();
});
executorApp.use('/executor-portal', executorPortal);

const adminApp = express();
adminApp.use(express.json());
adminApp.use((req, _res, next) => {
    req.session = {
        isLoggedIn: true,
        adminId: 'admin-reviewer',
        adminName: 'مراجع الإثبات',
        adminRole: 'master'
    };
    next();
});
adminApp.use(adminTransactions);

const mobileApp = express();
mobileApp.use(express.json());
mobileApp.use((req, _res, next) => {
    const header = String(req.headers['x-test-tenant'] || '').trim();
    if (header) req.tenant = { _id: new mongoose.Types.ObjectId(header) };
    next();
});
mobileApp.use('/api/mobile', mobileApi);

const executorToken = (tenant) => jwt.sign({
    userId: String(employee._id),
    accountType: 'executor',
    executorGroupId: String(group._id),
    sessionVersion: Number(employee.sessionVersion || 0),
    ...(tenant ? { tenantId: String(tenant) } : {})
}, process.env.JWT_SECRET, { expiresIn: '15m' });

beforeAll(async () => {
    ['WHATCHIMP_ENABLED', 'WHATCHIMP_API_TOKEN', 'WHATCHIMP_PHONE_NUMBER_ID', 'WHATCHIMP_RECEIPT_TEMPLATE', 'PUBLIC_APP_URL', 'RECEIPT_SHARE_SECRET', 'BRAND_PHONE_DISPLAY', 'BRAND_PHONE_TEL'].forEach((name) => {
        savedEnv[name] = process.env[name];
    });
    rememberEnv('WHATCHIMP_ENABLED', 'true');
    rememberEnv('WHATCHIMP_API_TOKEN', 'integration-test-token');
    rememberEnv('WHATCHIMP_PHONE_NUMBER_ID', 'integration-test-phone');
    rememberEnv('WHATCHIMP_RECEIPT_TEMPLATE', 'integration_receipt');
    rememberEnv('PUBLIC_APP_URL', 'https://receipts.test.invalid');
    rememberEnv('RECEIPT_SHARE_SECRET', 'integration-receipt-share-secret');
    rememberEnv('BRAND_PHONE_DISPLAY', undefined);
    rememberEnv('BRAND_PHONE_TEL', undefined);

    axiosPost = jest.spyOn(axios, 'post').mockResolvedValue({ data: {} });
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(replSet.getUri(), { serverSelectionTimeoutMS: 20000 });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    if (!hello.setName) throw new Error('MongoDB transactions require a replica set');

    const password = await require('bcryptjs').hash('unused', 4);
    tenantId = new mongoose.Types.ObjectId();
    company = await ClientCompany.create({ name: 'شركة إثبات تجريبية', phone: '01000002222', balance: 4200.25 });
    user = await User.create({
        name: 'عميل إثبات',
        phone: CUSTOMER_WHATSAPP,
        webUsername: 'split-proof-customer',
        webPassword: password,
        balance: 880.5,
        status: 'active'
    });
    group = await ExecutorGroup.create({
        name: 'منفذ إثبات',
        status: 'active',
        balance: 9100,
        serviceBalances: { vodafone: 9100 },
        tenantId
    });
    employee = await Employee.create({
        name: 'منفذ الجزء',
        role: 'operator',
        status: 'active',
        groupId: group._id,
        webUsername: 'split-proof-executor',
        webPassword: password,
        balance: 15,
        tenantId,
        sessionVersion: 0
    });
    pool = await ExecutorBalancePool.create({ name: 'مجمع تجريبي', groupId: group._id, balance: 250 });
    subAccount = await SubAccount.create({
        masterType: 'company',
        masterId: company._id,
        name: 'حساب فرعي',
        phone: '01000003333',
        webUsername: 'split-proof-sub',
        webPassword: password,
        balance: 40
    });
    await Ledger.create({
        entityId: company._id,
        entityModel: 'ClientCompany',
        transactionId: 'TEST-REF-2500',
        type: 'DEDUCTION',
        amount: 175.5,
        originalAmount: 2500,
        balanceBefore: 4375.75,
        balanceAfter: 4200.25,
        description: 'خصم العميل قبل إثبات الأجزاء'
    });
    await Ledger.create({
        entityId: group._id,
        entityModel: 'ExecutorGroup',
        transactionId: 'TEST-REF-2500',
        type: 'TRANSFER',
        amount: 2500,
        originalAmount: 2500,
        balanceBefore: 11600,
        balanceAfter: 9100,
        description: 'حركة المنفذ قبل إثبات الأجزاء'
    });
});

afterAll(async () => {
    axiosPost?.mockRestore();
    restoreEnv();
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    if (replSet) await replSet.stop();
});

afterEach(async () => {
    sendReceipt.mockReset();
    await Promise.all([
        Transaction.deleteMany({}),
        WhatsAppDelivery.deleteMany({})
    ]);
    if (fs.existsSync(PROOF_DIR)) {
        fs.readdirSync(PROOF_DIR)
            .filter((name) => name.includes('TEST-REF') || name.includes('part_'))
            .forEach((name) => fs.rmSync(path.join(PROOF_DIR, name), { force: true }));
    }
});

describe('split part proofs on MongoMemoryReplSet', () => {
    test('mongoose rejects a pipeline update until updatePipeline is set, then the service syncs both proofs', async () => {
        const tx = await seedTransfer({ customId: 'TEST-REF-2500' });
        expect(() => Transaction.updateOne({ _id: tx._id }, [
            { $set: { notes: 'pipeline-without-option' } }
        ])).toThrow(/updatePipeline/);

        const unchanged = await Transaction.findById(tx._id).lean();
        expect(unchanged.notes || '').not.toContain('pipeline-without-option');
        expect(unchanged.proofImages || []).toEqual([]);

        const capturedImages = [];
        sendReceipt.mockImplementation(async (payload) => {
            const imageBytes = fs.readFileSync(proofFile(payload.imageId));
            capturedImages.push(imageBytes);
            return {
                success: true,
                provider: 'whatchimp',
                messageId: `mock-${payload.partId}`
            };
        });

        const proto = Object.getPrototypeOf(createCanvas(1, 1).getContext('2d'));
        const originalFill = proto.fillText;
        const drawn = [];
        proto.fillText = function fillText(text, ...rest) {
            drawn.push(String(text));
            return originalFill.call(this, text, ...rest);
        };

        try {
            const result = await withStableFinance(() => issueSplitPartProofs(tx._id));
            expect(result.parts.map((item) => item.code)).toEqual(['PART_PROOF_SENT', 'PART_PROOF_SENT']);
            const saved = await Transaction.findById(tx._id);
            expect(part(saved, '1').status).toBe('success');
            expect(part(saved, '2').status).toBe('success');
            expect(part(saved, '1').customerProof.status).toBe('sent');
            expect(part(saved, '2').customerProof.status).toBe('sent');
            expect(part(saved, '1').phone).toBe(WALLET_A);
            expect(part(saved, '2').phone).toBe(WALLET_B);
            expect(part(saved, '1').amount).toBe(1000);
            expect(part(saved, '2').amount).toBe(1500);
            expect(fs.existsSync(proofFile(part(saved, '1').customerProof.imageId))).toBe(true);
            expect(fs.existsSync(proofFile(part(saved, '2').customerProof.imageId))).toBe(true);
            expect(saved.proofImages).toEqual([
                part(saved, '1').customerProof.imageId,
                part(saved, '2').customerProof.imageId
            ]);
            expect(saved.proofImage).toBe(saved.proofImages[0]);
            expect(sendReceipt).toHaveBeenCalledTimes(2);
            expect(sendReceipt).toHaveBeenNthCalledWith(1, expect.objectContaining({
                partAmount: 1000,
                amount: '1,000',
                partId: '1',
                senderWallet: WALLET_A,
                transferRecipient: RECIPIENT
            }));
            expect(sendReceipt).toHaveBeenNthCalledWith(2, expect.objectContaining({
                partAmount: 1500,
                amount: '1,500',
                partId: '2',
                senderWallet: WALLET_B,
                transferRecipient: RECIPIENT
            }));
            expect(sendReceipt.mock.calls[0][0].senderWallet).not.toBe('0913731533');
            expect(sendReceipt.mock.calls[1][0].senderWallet).not.toBe('0913731533');

            const supportAt = drawn.indexOf('الدعم الفني واتساب فقط');
            expect(drawn[supportAt + 1]).toBe('0913731533');
            expect(drawn).toEqual(expect.arrayContaining([WALLET_A, WALLET_B, RECIPIENT, '0913731533']));
            expect(drawn.filter((text) => text === WALLET_A).length).toBeGreaterThan(0);
            expect(drawn).not.toContain('2500');

            fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
            const samples = [
                ['rc-real-proof-part1-1000.png', part(saved, '1').customerProof.imageId],
                ['rc-real-proof-part2-1500.png', part(saved, '2').customerProof.imageId]
            ];
            for (const [name, imageId] of samples) {
                const image = await loadImage(proofFile(imageId));
                const canvas = createCanvas(image.width, image.height);
                canvas.getContext('2d').drawImage(image, 0, 0);
                const target = path.join(ARTIFACT_DIR, name);
                fs.writeFileSync(target, canvas.toBuffer('image/png'));
                expect(fs.statSync(target).size).toBeGreaterThan(1000);
            }
            expect(capturedImages).toHaveLength(2);
            expect(capturedImages.every((bytes) => bytes.length > 1000)).toBe(true);
        } finally {
            proto.fillText = originalFill;
        }
    });

    test('retries a failed send without regenerating the image or posting money', async () => {
        const tx = await seedTransfer({ customId: 'TEST-REF-RETRY' });
        const generateSpy = jest.spyOn(manualExecutorReceipt, 'generateManualExecutorReceiptBase64');
        sendReceipt.mockResolvedValueOnce({ success: false, code: 'WHATCHIMP_REQUEST_FAILED', message: 'temporary outage' });
        sendReceipt.mockResolvedValue({ success: true, provider: 'whatchimp', messageId: 'mock-retry' });

        await withStableFinance(async () => {
            const failed = await issueSplitPartProofs(tx._id);
            expect(failed.parts[0]).toMatchObject({ ok: false, proofStatus: 'failed' });
            const afterFailure = await Transaction.findById(tx._id);
            const imageId = part(afterFailure, '1').customerProof.imageId;
            expect(imageId).toBeTruthy();
            expect(part(afterFailure, '1').customerProof.status).toBe('failed');
            expect(part(afterFailure, '2').customerProof.status).toBe('sent');
            const hash = fileHash(imageId);
            const generated = generateSpy.mock.calls.length;

            const retried = await retrySplitPartProof(tx._id, '1');
            expect(retried).toMatchObject({ ok: true, proofStatus: 'sent', duplicate: false });
            const afterRetry = await Transaction.findById(tx._id);
            expect(part(afterRetry, '1').customerProof.imageId).toBe(imageId);
            expect(fileHash(imageId)).toBe(hash);
            expect(generateSpy.mock.calls.length).toBe(generated);
            expect(afterRetry.status).toBe('completed');
            expect(afterRetry.amount).toBe(2500);
        });

        const partOneSends = sendReceipt.mock.calls.filter((call) => call[0].partId === '1');
        expect(partOneSends).toHaveLength(2);
        expect(partOneSends[1][0]).toEqual(expect.objectContaining({
            partAmount: 1000,
            senderWallet: WALLET_A,
            transferRecipient: RECIPIENT,
            partId: '1'
        }));
        generateSpy.mockRestore();
    });

    test('a retry after success is a no-op and concurrent retries send at most once', async () => {
        const tx = await seedTransfer({ customId: 'TEST-REF-ONCE' });
        sendReceipt.mockResolvedValue({ success: true, provider: 'whatchimp', messageId: 'mock-once' });
        await issueSplitPartProofs(tx._id);
        sendReceipt.mockClear();

        await withStableFinance(async () => {
            const again = await retrySplitPartProof(tx._id, '1');
            expect(again).toMatchObject({ ok: true, duplicate: true, code: 'PART_PROOF_ALREADY_SENT', proofStatus: 'sent' });
            expect(sendReceipt).not.toHaveBeenCalled();

            await Transaction.updateOne(
                { _id: tx._id, 'executorSenderEntries.partId': '2' },
                { $set: { 'executorSenderEntries.$.customerProof.status': 'failed' } }
            );
            const concurrent = await Promise.all([
                retrySplitPartProof(tx._id, '2'),
                retrySplitPartProof(tx._id, '2')
            ]);
            const sent = concurrent.filter((item) => item.proofStatus === 'sent' && !item.duplicate);
            expect(sent.length).toBeLessThanOrEqual(1);
            expect(sendReceipt.mock.calls.filter((call) => call[0].partId === '2').length).toBeLessThanOrEqual(1);
            const saved = await Transaction.findById(tx._id);
            expect(saved.amount).toBe(2500);
            expect(saved.status).toBe('completed');
        });
    });

    test('admin, executor, and mobile retries send the failed part once', async () => {
        sendReceipt.mockResolvedValue({ success: true, provider: 'whatchimp', messageId: 'mock-entry' });
        const preset = 'proofs/TEST-REF-PRESET_part_1.jpg';
        fs.mkdirSync(PROOF_DIR, { recursive: true });
        fs.writeFileSync(path.join(process.cwd(), 'uploads', preset), Buffer.from('preset-image'));

        const adminTx = await seedTransfer({ customId: 'TEST-REF-ADMIN', proofStatus: 'failed', imageId: preset });
        await withStableFinance(async () => {
            const response = await request(adminApp)
                .post(`/transaction/${adminTx._id}/retry-part-proof/1`)
                .send({});
            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ success: true, partId: '1', proofStatus: 'sent' });
        });

        const executorTx = await seedTransfer({ customId: 'TEST-REF-EXECUTOR', proofStatus: 'failed', imageId: preset });
        await withStableFinance(async () => {
            const response = await request(executorApp)
                .post(`/executor-portal/api/retry-part-proof/${executorTx._id}/2`)
                .send({});
            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ success: true, partId: '2', proofStatus: 'sent' });
        });

        const mobileTx = await seedTransfer({
            customId: 'TEST-REF-MOBILE',
            tenant: tenantId,
            proofStatus: 'failed',
            imageId: preset
        });
        await withStableFinance(async () => {
            const response = await request(mobileApp)
                .post(`/api/mobile/executor/retry-part-proof/${mobileTx._id}/1`)
                .set('Authorization', `Bearer ${executorToken(tenantId)}`)
                .set('x-test-tenant', String(tenantId))
                .send({});
            expect(response.status).toBe(200);
            expect(response.body).toMatchObject({ success: true, partId: '1', proofStatus: 'sent' });
        });

        expect(sendReceipt).toHaveBeenCalledTimes(3);
        expect(paymentCalls()).toHaveLength(0);
    });

    test('mobile retry of a tenant-less transfer stays 404 when the request has a tenant', async () => {
        // The mobile retry route filters tenantId to the request tenant only.
        // complete-task on the same router uses executorTenantScope, which in
        // single-tenant mode also matches legacy rows with no tenantId. This
        // 404 is that stricter filter. It is not widened here.
        sendReceipt.mockResolvedValue({ success: true, provider: 'whatchimp', messageId: 'should-not-send' });
        const tx = await seedTransfer({ customId: 'TEST-REF-TENANTLESS', proofStatus: 'failed', imageId: 'proofs/missing.jpg' });
        await withStableFinance(async () => {
            const response = await request(mobileApp)
                .post(`/api/mobile/executor/retry-part-proof/${tx._id}/1`)
                .set('Authorization', `Bearer ${executorToken(tenantId)}`)
                .set('x-test-tenant', String(tenantId))
                .send({});
            expect(response.status).toBe(404);
            expect(response.body.code).toBe('NOT_FOUND');
        });
        expect(sendReceipt).not.toHaveBeenCalled();
        const saved = await Transaction.findById(tx._id);
        expect(part(saved, '1').customerProof.status).toBe('failed');
    });

    test('the retry script reopens an already sent part without sending again', async () => {
        const tx = await seedTransfer({ customId: 'TEST-REF-SCRIPT' });
        sendReceipt.mockResolvedValue({ success: true, provider: 'whatchimp', messageId: 'mock-script' });
        await issueSplitPartProofs(tx._id);
        sendReceipt.mockClear();
        const uri = replSet.getUri();
        expect(uri).toMatch(/127\.0\.0\.1|localhost/);

        await withStableFinance(async () => {
            const child = spawnSync(process.execPath, [
                path.join(process.cwd(), 'scripts', 'retrySplitPartProof.js'),
                String(tx._id),
                '1'
            ], {
                cwd: process.cwd(),
                encoding: 'utf8',
                env: {
                    ...process.env,
                    MONGODB_URI: uri,
                    MONGO_URI: uri,
                    WHATCHIMP_ENABLED: 'false',
                    WHATCHIMP_API_TOKEN: '',
                    WHATCHIMP_PHONE_NUMBER_ID: '',
                    NODE_ENV: 'test'
                }
            });
            expect(child.status).toBe(0);
            const line = String(child.stdout || '').trim().split('\n').filter(Boolean).pop();
            expect(JSON.parse(line)).toMatchObject({
                ok: true,
                duplicate: true,
                code: 'PART_PROOF_ALREADY_SENT',
                partId: '1',
                proofStatus: 'sent'
            });
        });
        expect(sendReceipt).not.toHaveBeenCalled();
        const saved = await Transaction.findById(tx._id);
        expect(saved.amount).toBe(2500);
        expect(await Transaction.countDocuments({ customId: 'TEST-REF-SCRIPT' })).toBe(1);
    });
});
