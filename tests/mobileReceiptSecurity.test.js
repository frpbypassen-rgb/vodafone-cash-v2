// tests/mobileReceiptSecurity.test.js
// ===============================================
// 🧪 Contract Tests — أمان إيصالات العمليات (Receipt Security)
// ===============================================
'use strict';

const request = require('supertest');
const express = require('express');
const { Readable } = require('stream');

// Mocks
jest.mock('../models/Transaction', () => {
    const M = jest.fn();
    M.findById = jest.fn();
    return M;
});

jest.mock('../models/ClientEmployee', () => {
    const M = jest.fn();
    M.findById = jest.fn();
    return M;
});

jest.mock('../models/ClientBot', () => {
    const M = jest.fn();
    M.findById = jest.fn();
    return M;
});

jest.mock('../models/ExecutorBot', () => {
    const M = jest.fn();
    M.findById = jest.fn();
    return M;
});

jest.mock('../middlewares/jwtAuth', () => ({
    JWT_SECRET: 'test-secret-key-that-is-long-enough-32chars',
    JWT_REFRESH_SECRET: 'test-refresh-secret-key-long-enough-32chars',
    authenticateJWT: (req, res, next) => {
        req.user = req.get('x-test-executor') === '1'
            ? { userId: 'manager-id', accountType: 'executor', executorGroupId: 'group-id' }
            : { userId: 'user-id-123', accountType: 'client_user', telegramId: '99887766' };
        next();
    }
}));

jest.mock('../services/auditService', () => ({
    logAction: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('telegraf', () => ({
    Telegram: jest.fn().mockImplementation(() => ({
        getFileLink: jest.fn().mockResolvedValue({ href: 'https://api.telegram.org/file/bot123/photos/file_0.jpg' })
    }))
}), { virtual: true });

jest.mock('axios', () => ({
    get: jest.fn()
}));

const Transaction = require('../models/Transaction');
const Employee = require('../models/Employee');
const axios = require('axios');
const app = express();
app.use(express.json());
app.use(require('../routes/mobileApi'));

describe('🖼️ Contract Tests: Receipt Security (Mobile API)', () => {
    const originalAdminBotToken = process.env.ADMIN_BOT_TOKEN;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.ADMIN_BOT_TOKEN = 'test-admin-bot-token';
        axios.get.mockResolvedValue({
            headers: { 'content-type': 'image/jpeg' },
            data: Readable.from(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
        });
    });

    afterAll(() => {
        if (originalAdminBotToken === undefined) {
            delete process.env.ADMIN_BOT_TOKEN;
        } else {
            process.env.ADMIN_BOT_TOKEN = originalAdminBotToken;
        }
    });

    test('T033 & T034: GET /transaction/image/:id should secure proxy link and check ownership', async () => {
        // Test case 1: Authorized user gets proxy URL or stream instead of direct Telegram URL in plain text response
        const mockTx = {
            _id: 'tx-id-abc',
            userId: 'user-id-123', // matches req.user.userId
            customId: 'ATT-001',
            proofImage: 'telegram-file-id-123'
        };

        Transaction.findById.mockResolvedValue(mockTx);

        const res = await request(app)
            .get('/transaction/image/tx-id-abc');

        // It should either stream the image directly or return a secure signed proxy url,
        // but it must NOT return a raw telegram API URL directly.
        expect(res.status).toBe(200);
        // Let's assert that the response is NOT a redirect to Telegram API or containing telegram domain
        if (res.headers['content-type'] && res.headers['content-type'].includes('json')) {
            expect(res.body.url).toBeDefined();
            expect(res.body.url).not.toContain('telegram.org');
        } else {
            // streamed image
            expect(res.headers['content-type']).toBeDefined();
        }
    });

    test('T034: GET /transaction/image/:id should return 403 Forbidden for unauthorized user', async () => {
        const mockTx = {
            _id: 'tx-id-abc',
            userId: 'different-telegram-id', // unauthorized
            customId: 'ATT-001',
            proofImage: 'telegram-file-id-123'
        };

        Transaction.findById.mockResolvedValue(mockTx);

        const res = await request(app)
            .get('/transaction/image/tx-id-abc');

        expect(res.status).toBe(403);
    });

    test('Receipt content tickets should be one-time use and proxied through the server', async () => {
        const mockTx = {
            _id: 'tx-id-abc',
            userId: 'user-id-123',
            customId: 'ATT-001',
            proofImage: 'telegram-file-id-123'
        };

        Transaction.findById.mockResolvedValue(mockTx);

        const ticketRes = await request(app).get('/transaction/image/tx-id-abc');

        expect(ticketRes.status).toBe(200);
        expect(ticketRes.body.url).toContain('/api/mobile/transaction/image/content?ticket=');
        expect(ticketRes.body.url).not.toContain('telegram.org');

        const parsedUrl = new URL(ticketRes.body.url);
        const localContentPath = `${parsedUrl.pathname.replace('/api/mobile', '')}${parsedUrl.search}`;

        const firstUse = await request(app).get(localContentPath);
        expect(firstUse.status).toBe(200);
        expect(firstUse.headers['content-type']).toContain('image/jpeg');
        expect(axios.get).toHaveBeenCalledTimes(1);

        const secondUse = await request(app).get(localContentPath);
        expect(secondUse.status).toBe(404);
        expect(secondUse.body).toEqual(expect.objectContaining({
            success: false,
            code: 'NOT_FOUND'
        }));
        expect(axios.get).toHaveBeenCalledTimes(1);
    });

    test('split receipts list official images and return inline part uploads only to the manager', async () => {
        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZ0AAAAASUVORK5CYII=';
        Transaction.findById.mockResolvedValue({
            _id: 'split-id', userId: 'user-id-123', executorGroupId: 'group-id',
            proofImages: ['official-1', 'official-2'],
            executorSenderEntries: [
                { partId: '1', status: 'success', proofImage: 'data:image/jpeg;base64,' + png, customerProof: { key: 'split:1', imageId: 'official-1' } },
                { partId: '2', status: 'success', customerProof: { key: 'split:2', imageId: 'official-2' } }
            ]
        });
        const employee = jest.spyOn(Employee, 'findById').mockReturnValue({ lean: async () => ({ role: 'manager' }) });
        try {
            const base = '/transaction/image/split-id';
            const catalog = await request(app).get(base + '?metadata=1').set('x-test-executor', '1').expect(200);
            expect(catalog.body).toMatchObject({ officialProofCount: 2, executorProofCount: 1 });
            const customer = await request(app).get(base + '?metadata=1').expect(200);
            expect(customer.body).toMatchObject({ officialProofCount: 2, executorProofCount: 0 });
            await request(app).get(base + '?source=executor').expect(403);
            const ticket = await request(app).get(base + '?source=executor').set('x-test-executor', '1').expect(200);
            expect(ticket.body.url).not.toContain(png);
            const contentPath = new URL(ticket.body.url).pathname.replace('/api/mobile', '') + new URL(ticket.body.url).search;
            await request(app).get(contentPath).expect(403);
            const image = await request(app).get(contentPath).set('x-test-executor', '1').expect(200).expect('Content-Type', /image\/png/);
            expect(image.body).toEqual(Buffer.from(png, 'base64'));

            const secondTicket = await request(app).get(base + '?source=executor').set('x-test-executor', '1').expect(200);
            const movedUrl = new URL(secondTicket.body.url);
            Transaction.findById.mockResolvedValue({ executorGroupId: 'other-group', executorProofImages: ['other.png'] });
            await request(app).get(movedUrl.pathname.replace('/api/mobile', '') + movedUrl.search)
                .set('x-test-executor', '1').expect(404);
        } finally {
            employee.mockRestore();
        }
    });
});
