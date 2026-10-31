'use strict';
jest.mock('../services/reportPdfService', () => ({
    generateAdminReportPdf: jest.fn(async () => Buffer.from('%PDF-1.4\nlocal-test')),
}));
jest.mock('../services/proofStorageService', () => ({
    proofSourceUrl: jest.fn((x) => x),
    streamProofImage: jest.fn(async (_source, res) => res.type('png').send(Buffer.from('test-image'))),
}));
const mongoose = require('mongoose'),
    express = require('express'),
    request = require('supertest');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../models/User'),
    Sub = require('../models/SubAccount'),
    Transaction = require('../models/Transaction');
const { streamProofImage } = require('../services/proofStorageService');
jest.setTimeout(120000);
let mongo, app, owner, other, child, tenant, tx, foreignTenant;
beforeAll(async () => {
    mongo = await MongoMemoryServer.create({
        binary: { version: '7.0.24' },
        instance: { launchTimeout: 60000 },
    });
    await mongoose.connect(mongo.getUri());
    tenant = new mongoose.Types.ObjectId();
    foreignTenant = new mongoose.Types.ObjectId();
    owner = await User.create({
        webUsername: 'receipt.owner',
        webPassword: 'testing-password',
        phone: '0911000001',
        status: 'active',
        role: 'user',
        tenantId: tenant,
        balance: 100,
    });
    other = await User.create({
        webUsername: 'receipt.other',
        webPassword: 'testing-password',
        phone: '0911000002',
        status: 'active',
        role: 'user',
        tenantId: tenant,
    });
    child = await Sub.create({
        webUsername: 'receipt.child',
        webPassword: 'testing-password',
        name: 'Child',
        masterType: 'user',
        masterId: owner._id,
        status: 'active',
        tenantId: tenant,
    });
    tx = new mongoose.Types.ObjectId();
    await Transaction.collection.insertOne({
        _id: tx,
        customId: 'PRIVATE-RECEIPT',
        userId: owner.phone,
        tenantId: tenant,
        status: 'completed',
        transferType: 'vodafone',
        amount: 100,
        costLYD: 10,
        createdAt: new Date('2026-10-01T12:00:00Z'),
        proofImage: 'proofs/customer.png',
        executorProofImages: ['proofs/executor-secret.png'],
        apiResultData: { secret: 'NO_LEAK' },
    });
    app = express();
    app.use((req, _res, next) => {
        req.session = {
            isClientLoggedIn: true,
            accountType: req.get('x-sub') === 'yes' ? 'sub_client' : 'user',
            clientId: req.get('x-owner') || String(owner._id),
            clientSessionVersion: 0,
        };
        next();
    });
    app.use('/client', require('../routes/retailOperationDetails'));
});
afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
});

test('PDF export uses the authenticated owner and full selected period, not query account IDs', async () => {
    const { generateAdminReportPdf } = require('../services/reportPdfService');
    generateAdminReportPdf.mockClear();
    await Transaction.collection.insertMany([
        {
            customId: 'FOREIGN-PDF',
            userId: other.phone,
            tenantId: tenant,
            companyId: null,
            subAccountId: null,
            status: 'completed',
            transferType: 'vodafone',
            amount: 100,
            costLYD: 999,
            createdAt: new Date('2026-10-02T12:00:00Z'),
        },
        {
            customId: 'OTHER-TENANT-PDF',
            userId: owner.phone,
            tenantId: new mongoose.Types.ObjectId(),
            status: 'completed',
            transferType: 'vodafone',
            amount: 100,
            costLYD: 999,
            createdAt: new Date('2026-10-02T12:00:00Z'),
        },
        {
            customId: 'PDF-OPENING',
            userId: owner.phone,
            tenantId: tenant,
            status: 'deposit',
            amount: 100,
            createdAt: new Date('2026-09-30T12:00:00Z'),
        },
    ]);
    const countBefore = await Transaction.countDocuments();
    const response = await request(app)
        .get('/client/api/retail-reports/download.pdf')
        .query({
            dateType: 'month',
            dateValue: '2026-10',
            subId: String(other._id),
            mainCategory: 'agent',
            search: 'NO_MATCH',
        })
        .expect(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['content-disposition']).toContain('attachment;');
    expect(response.headers['cache-control']).toContain('no-store');
    const report = generateAdminReportPdf.mock.calls[0][1].report;
    expect(report.entityInfo.name).toBe(owner.name);
    expect(report.scope.subId).toBe(String(owner._id));
    expect(report.completedOperations.some((row) => row.customId === 'PRIVATE-RECEIPT')).toBe(true);
    expect(JSON.stringify(report)).not.toContain('NO_LEAK');
    expect(JSON.stringify(report)).not.toContain('FOREIGN-PDF');
    expect(JSON.stringify(report)).not.toContain('OTHER-TENANT-PDF');
    expect(await Transaction.countDocuments()).toBe(countBefore);
    expect(report.range.dateType).toBe('month');
    await Transaction.deleteMany({ customId: { $in: ['FOREIGN-PDF', 'OTHER-TENANT-PDF', 'PDF-OPENING'] } });
});

test('sub-account PDF includes only its own customer price, not parent pricing', async () => {
    await Transaction.collection.insertOne({
        customId: 'SUB-PDF',
        subAccountId: child._id,
        tenantId: tenant,
        status: 'completed',
        transferType: 'vodafone',
        amount: 100,
        costLYD: 5,
        subAccountCostLYD: 8,
        exchangeRate: 20,
        subClientRate: 12,
        agencyPricing: { customerChargeLYD: 9, customerRate: 11 },
        createdAt: new Date('2026-10-04T12:00:00Z'),
    });
    const { generateAdminReportPdf } = require('../services/reportPdfService');
    generateAdminReportPdf.mockClear();
    await request(app)
        .get('/client/api/retail-reports/download.pdf?dateType=month&dateValue=2026-10')
        .set('x-sub', 'yes')
        .set('x-owner', String(child._id))
        .expect(200);
    const report = generateAdminReportPdf.mock.calls[0][1].report;
    expect(report.completedOperations).toHaveLength(1);
    expect(report.completedOperations[0].costLYD).toBe(9);
    expect(report.completedOperations[0].exchangeRate).toBe(11);
    expect(JSON.stringify(report)).not.toContain('agencyPricing');
    expect(JSON.stringify(report)).not.toContain('subAccountCostLYD');
});

test('PDF rejects malformed dates before rendering and returns a safe unavailable error', async () => {
    const { generateAdminReportPdf } = require('../services/reportPdfService');
    generateAdminReportPdf.mockClear();
    await request(app)
        .get('/client/api/retail-reports/download.pdf?dateType=month&dateValue=bad')
        .expect(422);
    expect(generateAdminReportPdf).not.toHaveBeenCalled();
    generateAdminReportPdf.mockRejectedValueOnce(
        Object.assign(new Error('private browser path'), { code: 'PDF_BROWSER_NOT_FOUND' })
    );
    const response = await request(app)
        .get('/client/api/retail-reports/download.pdf?dateType=month&dateValue=2026-10')
        .expect(503);
    expect(response.text).not.toContain('private browser path');
});
test('owner sees sanitized details and customer receipt, other accounts cannot read either', async () => {
    const response = await request(app)
        .get('/client/api/retail-transactions/' + tx)
        .expect(200);
    expect(response.body.transaction.reference).toBe('PRIVATE-RECEIPT');
    expect(response.body.transaction.receipts).toHaveLength(1);
    expect(JSON.stringify(response.body)).not.toContain('NO_LEAK');
    expect(JSON.stringify(response.body)).not.toContain('executor-secret');
    await request(app).get(response.body.transaction.receipts[0].url).expect(200);
    streamProofImage.mockClear();
    await request(app)
        .get('/client/api/retail-transactions/' + tx)
        .set('x-owner', String(other._id))
        .expect(404);
    await request(app)
        .get('/client/api/retail-transactions/' + tx + '/proof/0')
        .set('x-owner', String(other._id))
        .expect(404);
    expect(streamProofImage).not.toHaveBeenCalled();
    expect((await User.findById(owner._id)).balance).toBe(100);
});
test('same user identifier in a different tenant is inaccessible', async () => {
    const id = new mongoose.Types.ObjectId();
    await Transaction.collection.insertOne({
        _id: id,
        customId: 'FOREIGN-TENANT',
        userId: owner.phone,
        tenantId: foreignTenant,
        amount: 100,
        status: 'completed',
        proofImage: 'proofs/foreign.png',
    });
    await request(app)
        .get('/client/api/retail-transactions/' + id)
        .expect(404);
    await request(app)
        .get('/client/api/retail-transactions/' + id + '/proof/0')
        .expect(404);
});
test('subordinate account gets its own customer charge and cannot see parent history', async () => {
    const id = new mongoose.Types.ObjectId();
    await Transaction.collection.insertOne({
        _id: id,
        customId: 'CHILD-RECEIPT',
        subAccountId: child._id,
        tenantId: tenant,
        amount: 200,
        status: 'completed',
        costLYD: 10,
        agencyPricing: { customerChargeLYD: 30, customerRate: 6.666 },
        proofImage: 'proofs/child.png',
    });
    const response = await request(app)
        .get('/client/api/retail-transactions/' + id)
        .set('x-sub', 'yes')
        .set('x-owner', String(child._id))
        .expect(200);
    expect(response.body.transaction.costLYD).toBe(30);
    await request(app)
        .get('/client/api/retail-transactions/' + tx)
        .set('x-sub', 'yes')
        .set('x-owner', String(child._id))
        .expect(404);
    await request(app)
        .get('/client/api/retail-transactions/' + tx + '/proof/0oops')
        .expect(404);
});
test('report HTTP endpoint uses the same authenticated owner boundary', async () => {
    const response = await request(app)
        .get('/client/api/retail-reports?dateType=month&dateValue=2026-10')
        .expect(200);
    expect(response.body.summary.count).toBe(1);
    expect(response.body.rows[0].id).toBe(String(tx));
    const otherResponse = await request(app)
        .get('/client/api/retail-reports?dateType=month&dateValue=2026-10')
        .set('x-owner', String(other._id))
        .expect(200);
    expect(otherResponse.body.summary.count).toBe(0);
});
