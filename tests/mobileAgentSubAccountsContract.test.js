// tests/mobileAgentSubAccountsContract.test.js
'use strict';

const request = require('supertest');
const express = require('express');

// Mocks
jest.mock('../models/User', () => {
    const M = jest.fn();
    M.findOne = jest.fn();
    M.findById = jest.fn();
    M.updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    M.modelName = 'User';
    return M;
});

jest.mock('../models/Employee', () => {
    const M = jest.fn();
    M.findOne = jest.fn();
    M.findById = jest.fn();
    M.modelName = 'Employee';
    return M;
});

jest.mock('../models/ClientEmployee', () => {
    const M = jest.fn();
    M.findOne = jest.fn();
    M.findById = jest.fn();
    M.modelName = 'ClientEmployee';
    return M;
});

jest.mock('../models/SubAccount', () => {
    const M = jest.fn();
    M.findOne = jest.fn();
    M.findById = jest.fn();
    M.find = jest.fn();
    M.countDocuments = jest.fn();
    M.create = jest.fn();
    M.modelName = 'SubAccount';
    return M;
});

jest.mock('../models/Transaction', () => {
    const M = jest.fn();
    M.findOne = jest.fn();
    M.create = jest.fn();
    M.find = jest.fn();
    M.countDocuments = jest.fn();
    M.modelName = 'Transaction';
    return M;
});

jest.mock('../models/Settings', () => ({
    findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
            rateLevel1: 6.50,
            rateLevel2: 6.45,
            rateLevel3: 6.40,
            isManualClosed: false
        })
    })
}));

jest.mock('../middlewares/jwtAuth', () => ({
    JWT_SECRET: 'test-secret-key-that-is-long-enough-32chars',
    JWT_REFRESH_SECRET: 'test-refresh-secret-key-long-enough-32chars',
    authenticateJWT: (req, res, next) => {
        req.user = { userId: 'agent-user-id-123', accountType: 'client_user' };
        next();
    }
}));

jest.mock('../services/auditService', () => ({
    logAction: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../services/walletService', () => ({
    updateBalanceWithLedger: jest.fn().mockResolvedValue({ success: true })
}));

jest.mock('express-rate-limit', () => () => (req, res, next) => next());

const User = require('../models/User');
const SubAccount = require('../models/SubAccount');
const Transaction = require('../models/Transaction');
const ClientEmployee = require('../models/ClientEmployee');
const Employee = require('../models/Employee');
const walletService = require('../services/walletService');
const mongoose = require('mongoose');

const mockMongooseSession = {
    startTransaction: jest.fn(),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    abortTransaction: jest.fn().mockResolvedValue(undefined),
    endSession: jest.fn()
};

jest.spyOn(mongoose, 'startSession').mockResolvedValue(mockMongooseSession);

const app = express();
app.use(express.json());
app.use('/api/mobile', require('../routes/mobileApi'));

describe('Mobile Agent SubAccounts Contract', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mongoose.startSession.mockResolvedValue(mockMongooseSession);
    });

    it('should fetch overview details of sub-accounts', async () => {
        const mockAgent = {
            _id: 'agent-user-id-123',
            name: 'Agent User',
            role: 'agent',
            status: 'active',
            balance: 1000,
            creditLimit: 0,
            accountCode: 'AGENT001'
        };

        const mockSubs = [
            {
                _id: 'sub-active-id',
                name: 'Active Sub',
                phone: '01022222222',
                status: 'active',
                creditLimit: 100,
                balance: 50,
                customMargin: 0.10
            },
            {
                _id: 'sub-banned-id',
                name: 'Banned Sub',
                phone: '01033333333',
                status: 'banned',
                creditLimit: 50,
                balance: -10,
                customMargin: 0.10
            }
        ];

        User.findById.mockResolvedValue(mockAgent);
        SubAccount.find.mockResolvedValue(mockSubs);

        const res = await request(app)
            .get('/api/mobile/agent/overview')
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.agent.name).toBe('Agent User');
        expect(res.body.summary.subAccountsCount).toBe(2);
        expect(res.body.summary.activeSubAccountsCount).toBe(1);
        expect(res.body.summary.totalCreditLimit).toBe(150);
        expect(res.body.summary.totalDebt).toBe(10); // abs(-10)
    });

    it('should list sub-accounts with filter/search and pagination', async () => {
        const mockAgent = {
            _id: 'agent-user-id-123',
            name: 'Agent User',
            role: 'agent',
            status: 'active'
        };

        const mockSubs = [
            {
                _id: 'sub-cairo-id',
                name: 'Cairo Branch',
                phone: '01022222222',
                status: 'active',
                creditLimit: 100,
                balance: 50,
                customMargin: 0.10
            }
        ];

        User.findById.mockResolvedValue(mockAgent);
        SubAccount.countDocuments.mockResolvedValue(1);

        const mockFindChain = {
            sort: jest.fn().mockReturnThis(),
            skip: jest.fn().mockReturnThis(),
            limit: jest.fn().mockResolvedValue(mockSubs)
        };
        SubAccount.find.mockReturnValue(mockFindChain);

        const res = await request(app)
            .get('/api/mobile/agent/sub-accounts?status=active')
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.total).toBe(1);
        expect(res.body.data).toHaveLength(1);
        expect(res.body.data[0].name).toBe('Cairo Branch');
    });

    it('should retrieve sub-account details', async () => {
        const mockAgent = {
            _id: 'agent-user-id-123',
            name: 'Agent User',
            role: 'agent',
            status: 'active'
        };

        const mockSub = {
            _id: 'sub-cairo-id',
            masterType: 'user',
            masterId: 'agent-user-id-123',
            name: 'Cairo Branch',
            phone: '01022222222',
            webUsername: 'cairosub',
            status: 'active',
            creditLimit: 100,
            balance: 50,
            customMargin: 0.10
        };

        User.findById.mockResolvedValue(mockAgent);
        SubAccount.findById.mockResolvedValue(mockSub);

        const res = await request(app)
            .get(`/api/mobile/agent/sub-accounts/${mockSub._id}`)
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.subAccount.id).toMatch(/^mob_/);
        expect(res.body.subAccount.id).not.toBe(String(mockSub._id));
        expect(res.body.subAccount.webUsername).toBe('cairosub');
        expect(res.body.subAccount.customMargin).toBe(0.10);
        expect(res.body.subAccount.cardMargin).toBeUndefined();
    });

    it('should create sub-account idempotently and validate username unique checks', async () => {
        const mockAgent = {
            _id: 'agent-user-id-123',
            name: 'Agent User',
            role: 'agent',
            status: 'active'
        };

        const mockSub = {
            _id: 'sub-new-id',
            masterType: 'user',
            masterId: 'agent-user-id-123',
            name: 'New Sub POS',
            phone: '01099999999',
            webUsername: 'newsubpos',
            status: 'active',
            creditLimit: 200,
            balance: 0,
            customMargin: 0.05
        };

        User.findById.mockResolvedValue(mockAgent);
        
        // 1. Idempotency test (request username that already exists under same agent)
        SubAccount.findOne
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(mockSub);
        const resIdemp = await request(app)
            .post('/api/mobile/agent/sub-accounts')
            .set('Idempotency-Key', '11111111-1111-1111-1111-111111111111')
            .send({
                name: 'New Sub POS',
                phone: '01099999999',
                username: 'newsubpos',
                password: 'password123',
                creditLimit: 200,
                customMargin: 0.05
            })
            .expect(200);

        expect(resIdemp.body.success).toBe(true);
        expect(resIdemp.body.message).toContain('Idempotent');
        expect(resIdemp.body.subAccount.id).toMatch(/^mob_/);
        expect(resIdemp.body.subAccount.id).not.toBe(String(mockSub._id));

        // 2. Creation success test (username does not exist anywhere)
        SubAccount.findOne.mockResolvedValue(null);
        User.findOne.mockResolvedValue(null);
        ClientEmployee.findOne.mockResolvedValue(null);
        Employee.findOne.mockResolvedValue(null);
        SubAccount.create.mockResolvedValue(mockSub);

        const resCreate = await request(app)
            .post('/api/mobile/agent/sub-accounts')
            .set('Idempotency-Key', '11111111-1111-1111-1111-111111111112')
            .send({
                name: 'New Sub POS',
                phone: '01099999999',
                username: 'newsubpos',
                password: 'password123',
                creditLimit: 200,
                customMargin: 0.05
            })
            .expect(201);

        expect(resCreate.body.success).toBe(true);
        expect(resCreate.body.subAccount.webUsername).toBe('newsubpos');
        expect(resCreate.body.subAccount.id).toMatch(/^mob_/);
        expect(resCreate.body.subAccount.id).not.toBe(String(mockSub._id));
        expect(resCreate.body.subAccount.cardMargin).toBeUndefined();
        expect(SubAccount.create).toHaveBeenCalledWith(expect.not.objectContaining({
            cardMargin: expect.anything()
        }));

        // 3. Collision with user webUsername
        User.findOne.mockResolvedValue({ _id: 'other-user-id' });
        await request(app)
            .post('/api/mobile/agent/sub-accounts')
            .set('Idempotency-Key', '11111111-1111-1111-1111-111111111113')
            .send({
                name: 'Colliding POS',
                username: 'newsubpos',
                password: 'password123'
            })
            .expect(409);
    });

    it('should update credit limit idempotently', async () => {
        const mockAgent = {
            _id: 'agent-user-id-123',
            name: 'Agent User',
            role: 'agent',
            status: 'active'
        };

        const mockSub = {
            _id: 'sub-cairo-id',
            masterType: 'user',
            masterId: 'agent-user-id-123',
            name: 'Cairo Branch',
            phone: '01022222222',
            webUsername: 'cairosub',
            status: 'active',
            creditLimit: 100,
            balance: 50,
            customMargin: 0.10,
            save: jest.fn().mockResolvedValue(true)
        };

        User.findById.mockResolvedValue(mockAgent);
        SubAccount.findById.mockResolvedValue(mockSub);

        const res = await request(app)
            .patch(`/api/mobile/agent/sub-accounts/${mockSub._id}/credit-limit`)
            .set('Idempotency-Key', '22222222-2222-2222-2222-222222222222')
            .send({
                creditLimit: 250
            })
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.subAccount.creditLimit).toBe(250);

        // Retry with same value
        mockSub.creditLimit = 250;
        const resRetry = await request(app)
            .patch(`/api/mobile/agent/sub-accounts/${mockSub._id}/credit-limit`)
            .set('Idempotency-Key', '22222222-2222-2222-2222-222222222222')
            .send({
                creditLimit: 250
            })
            .expect(200);

        expect(resRetry.body.message).toContain('Idempotent');
    });

    it("should reject lowering the credit limit below the customer's outstanding debt", async () => {
        const mockAgent = {
            _id: 'agent-user-id-123',
            name: 'Agent User',
            role: 'agent',
            status: 'active'
        };
        const mockSub = {
            _id: 'sub-credit-debt-id',
            masterType: 'user',
            masterId: 'agent-user-id-123',
            name: 'Credit Customer',
            webUsername: 'creditcustomer',
            status: 'active',
            creditLimit: 1000,
            balance: -100,
            save: jest.fn().mockResolvedValue(true)
        };

        User.findById.mockResolvedValue(mockAgent);
        SubAccount.findById.mockResolvedValue(mockSub);

        const res = await request(app)
            .patch(`/api/mobile/agent/sub-accounts/${mockSub._id}/credit-limit`)
            .set('Idempotency-Key', '22222222-2222-2222-2222-222222222223')
            .send({ creditLimit: 99 })
            .expect(409);

        expect(res.body.code).toBe('CREDIT_LIMIT_BELOW_OUTSTANDING_DEBT');
        expect(mockSub.save).not.toHaveBeenCalled();
        expect(mockSub.creditLimit).toBe(1000);
    });

    it('should update status to explicit value active or banned', async () => {
        const mockAgent = {
            _id: 'agent-user-id-123',
            name: 'Agent User',
            role: 'agent',
            status: 'active'
        };

        const mockSub = {
            _id: 'sub-cairo-id',
            masterType: 'user',
            masterId: 'agent-user-id-123',
            name: 'Cairo Branch',
            phone: '01022222222',
            webUsername: 'cairosub',
            status: 'active',
            creditLimit: 100,
            balance: 50,
            customMargin: 0.10,
            save: jest.fn().mockResolvedValue(true)
        };

        User.findById.mockResolvedValue(mockAgent);
        SubAccount.findById.mockResolvedValue(mockSub);

        // Update to banned
        let res = await request(app)
            .patch(`/api/mobile/agent/sub-accounts/${mockSub._id}/status`)
            .set('Idempotency-Key', '33333333-3333-3333-3333-333333333333')
            .send({
                status: 'banned'
            })
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.subAccount.status).toBe('banned');

        // Repeating request shouldn't toggle back (natural idempotency)
        mockSub.status = 'banned';
        res = await request(app)
            .patch(`/api/mobile/agent/sub-accounts/${mockSub._id}/status`)
            .set('Idempotency-Key', '33333333-3333-3333-3333-333333333333')
            .send({
                status: 'banned'
            })
            .expect(200);

        expect(res.body.subAccount.status).toBe('banned');
    });

    it('should execute settlements with ledger entries and balance checks', async () => {
        const mockAgent = {
            _id: 'agent-user-id-123',
            name: 'Agent User',
            role: 'agent',
            status: 'active'
        };

        const mockSub = {
            _id: 'sub-cairo-id',
            masterType: 'user',
            masterId: 'agent-user-id-123',
            name: 'Cairo Branch',
            phone: '01022222222',
            webUsername: 'cairosub',
            status: 'active',
            creditLimit: 100,
            balance: 100,
            customMargin: 0.10
        };

        User.findById.mockResolvedValue(mockAgent);
        SubAccount.findById.mockResolvedValue(mockSub);

        // 1. Deposit settlement
        Transaction.findOne.mockResolvedValue(null);
        walletService.updateBalanceWithLedger.mockResolvedValue({ success: true });
        
        const mockTx = {
            customId: 'SET-123456',
            status: 'deposit',
            amount: 50
        };
        Transaction.create.mockResolvedValue(mockTx);

        // Return updated sub account inside executeSettlement queries
        SubAccount.findById.mockImplementation(async (id) => {
            return {
                ...mockSub,
                balance: 150
            };
        });

        let res = await request(app)
            .post(`/api/mobile/agent/sub-accounts/${mockSub._id}/settlements`)
            .set('Idempotency-Key', '44444444-4444-4444-4444-444444444444')
            .send({
                type: 'deposit',
                amount: 50,
                notes: 'Top up'
            })
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.subAccount.balance).toBe(150);
        expect(mongoose.startSession).toHaveBeenCalled();
        expect(walletService.updateBalanceWithLedger).toHaveBeenCalledWith(
            'SubAccount',
            mockSub._id,
            50,
            'DEPOSIT',
            expect.any(String),
            expect.any(String),
            expect.objectContaining({ session: expect.any(Object), minBalance: 0 })
        );

        // 2. Over-withdrawal check
        SubAccount.findById.mockResolvedValue(mockSub); // reset balance to 100
        Transaction.findOne.mockResolvedValue(null);
        const createCallsBeforeOverdraw = Transaction.create.mock.calls.length;
        walletService.updateBalanceWithLedger.mockRejectedValueOnce(new Error('INSUFFICIENT_BALANCE'));

        await request(app)
            .post(`/api/mobile/agent/sub-accounts/${mockSub._id}/settlements`)
            .set('Idempotency-Key', '44444444-4444-4444-4444-444444444446')
            .send({
                type: 'withdraw',
                amount: 150, // exceeds balance of 100
                notes: 'Overdraw'
            })
            .expect(400); // Insufficient balance

        expect(Transaction.create).toHaveBeenCalledTimes(createCallsBeforeOverdraw);
    });

    it('should reject settlement idempotency key reuse with a different payload', async () => {
        const mockAgent = {
            _id: 'agent-user-id-123',
            name: 'Agent User',
            role: 'agent',
            status: 'active'
        };

        const mockSub = {
            _id: 'sub-cairo-id',
            masterType: 'user',
            masterId: 'agent-user-id-123',
            name: 'Cairo Branch',
            phone: '01022222222',
            webUsername: 'cairosub',
            status: 'active',
            creditLimit: 100,
            balance: 100,
            customMargin: 0.10
        };

        User.findById.mockResolvedValue(mockAgent);
        SubAccount.findById.mockResolvedValue(mockSub);
        Transaction.findOne.mockResolvedValue({
            customId: 'SET-123456',
            subAccountId: mockSub._id,
            idempotencyFingerprint: 'different-fingerprint',
            status: 'deposit',
            amount: 50
        });

        await request(app)
            .post(`/api/mobile/agent/sub-accounts/${mockSub._id}/settlements`)
            .set('Idempotency-Key', '44444444-4444-4444-4444-444444444447')
            .send({
                type: 'withdraw',
                amount: 25,
                notes: 'Different payload'
            })
            .expect(409);

        expect(walletService.updateBalanceWithLedger).not.toHaveBeenCalled();
    });
});
