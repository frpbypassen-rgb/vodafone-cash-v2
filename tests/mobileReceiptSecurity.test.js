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
        req.user = { userId: 'user-id-123', accountType: 'client_user', telegramId: '99887766' };
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
});
