'use strict';

const request = require('supertest');
const express = require('express');

// Mock middlewares
jest.mock('../middlewares/jwtAuth', () => ({
    authenticateJWT: (req, _res, next) => {
        req.user = {
            userId: 'user-kyc-123',
            accountType: 'client_user'
        };
        next();
    }
}));

jest.mock('../middlewares/auth', () => ({
    requireAuth: (req, _res, next) => {
        req.session = { adminName: 'Admin-Test' };
        next();
    }
}));

// Mock rate limiters and trust engines
jest.mock('express-rate-limit', () => () => (req, res, next) => next());
jest.mock('../src/Presentation/Middlewares/deviceTrustMiddleware', () => ({
    deviceTrustMiddleware: (req, res, next) => next()
}));
jest.mock('../src/Presentation/Middlewares/mfaMiddleware', () => ({
    mfaMiddleware: (req, res, next) => next()
}));
jest.mock('../validators/mobileValidators', () => ({
    loginValidator: [(_r, _s, n) => n()],
    transferValidator: [(_r, _s, n) => n()],
    cancelTaskValidator: [(_r, _s, n) => n()],
    completeTaskValidator: [(_r, _s, n) => n()],
    refreshTokenValidator: [(_r, _s, n) => n()],
}));

// Mock model saves and updates to avoid DB connections
jest.mock('../models/Transaction', () => ({}));
jest.mock('../models/ExecutorGroup', () => ({}));
jest.mock('../models/ClientCompany', () => ({}));
jest.mock('../models/User', () => ({}));
jest.mock('../models/Employee', () => ({}));
jest.mock('../models/ClientEmployee', () => ({}));
jest.mock('../models/Admin', () => ({}));
jest.mock('../models/Notification', () => ({}));
jest.mock('../models/SupportTicket', () => ({}));

const mobileApi = require('../routes/mobileApi');
const adminTransactions = require('../routes/adminTransactions');

describe('KYC Endpoints Tests', () => {
    let app;

    beforeAll(() => {
        app = express();
        app.use(express.json());
        app.use('/api/mobile', mobileApi);
        app.use('/', adminTransactions);
    });

    test('POST /api/mobile/client/kyc/submit should submit document successfully', async () => {
        const res = await request(app)
            .post('/api/mobile/client/kyc/submit')
            .send({
                documentType: 'passport',
                fileUrl: 'http://example.com/id.jpg',
                fullName: 'Ahmed KYC User'
            })
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.message).toBe('تم تقديم مستند الهوية بنجاح وهو قيد المراجعة');
    });

    test('GET /api/mobile/client/kyc/status should return status successfully', async () => {
        const res = await request(app)
            .get('/api/mobile/client/kyc/status')
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.data.status).toBe('pending');
    });

    test('POST /admin/kyc/review should update KYC status successfully', async () => {
        const res = await request(app)
            .post('/admin/kyc/review')
            .send({
                userId: 'user-kyc-123',
                status: 'verified',
                reason: 'Documents look correct'
            })
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.message).toBe('تم تحديث حالة KYC بنجاح');

        // Verify updated status on client endpoint
        const statusRes = await request(app)
            .get('/api/mobile/client/kyc/status')
            .expect(200);

        expect(statusRes.body.data.status).toBe('verified');
        expect(statusRes.body.data.reason).toBe('Documents look correct');
    });
});
