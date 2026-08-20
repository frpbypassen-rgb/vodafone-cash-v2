// tests/mobileSubAccountAuthContract.test.js
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
    M.findOne = jest.fn().mockReturnValue({
        populate: jest.fn().mockResolvedValue(null)
    });
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

jest.mock('../models/AgentEmployee', () => {
    const M = jest.fn();
    M.findOne = jest.fn().mockResolvedValue(null);
    M.findById = jest.fn();
    M.updateOne = jest.fn().mockResolvedValue({ modifiedCount: 0 });
    M.modelName = 'AgentEmployee';
    return M;
});

jest.mock('../models/ClientBot', () => {
    const M = jest.fn();
    M.findById = jest.fn();
    M.modelName = 'ClientBot';
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

jest.mock('../models/SubAccount', () => {
    const M = jest.fn();
    M.findOne = jest.fn();
    M.findById = jest.fn();
    M.updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    M.modelName = 'SubAccount';
    return M;
});

jest.mock('../models/MobileDeviceSession', () => ({
    create: jest.fn().mockResolvedValue({ _id: 'device-session-id' })
}));

jest.mock('../middlewares/jwtAuth', () => ({
    JWT_SECRET: 'test-secret-key-that-is-long-enough-32chars',
    JWT_REFRESH_SECRET: 'test-refresh-secret-key-long-enough-32chars',
    authenticateJWT: (req, res, next) => {
        req.user = { userId: 'sub-account-id-123', accountType: 'sub_client' };
        next();
    }
}));

jest.mock('../services/auditService', () => ({
    logAction: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('bcryptjs', () => ({
    compare: jest.fn().mockResolvedValue(true),
    hash: jest.fn().mockResolvedValue('$2b$12$hashed')
}));

jest.mock('express-rate-limit', () => () => (req, res, next) => next());

const User = require('../models/User');
const SubAccount = require('../models/SubAccount');
const Settings = require('../models/Settings');
const bcrypt = require('bcryptjs');

const app = express();
app.use(express.json());
app.use('/api/mobile', require('../routes/mobileApi'));

describe('Mobile SubClient Auth Contract', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('should login successfully as a sub_client and return correct DTO structure', async () => {
        const mockSub = {
            _id: 'sub-account-id-123',
            masterType: 'user',
            masterId: 'master-agent-id-123',
            name: 'Sub Point of Sale',
            phone: '01022222222',
            webUsername: 'subpos',
            webPassword: '$2b$12$hashed',
            customMargin: 0.10,
            creditLimit: 100,
            balance: 50,
            status: 'active'
        };

        const mockMaster = {
            _id: 'master-agent-id-123',
            name: 'Master Agent',
            phone: '01011111111',
            role: 'agent',
            tier: 2,
            balance: 500,
            status: 'active'
        };

        SubAccount.findOne.mockResolvedValue(mockSub);
        SubAccount.findById.mockResolvedValue(mockSub);
        User.findById.mockResolvedValue(mockMaster);

        const res = await request(app)
            .post('/api/mobile/login')
            .send({
                username: 'subpos',
                password: 'subpassword'
            })
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.token).toBeDefined();
        expect(res.body.refreshToken).toBeDefined();
        expect(res.body.id).toBe(mockSub._id);
        expect(res.body.accountType).toBe('sub_client');
        expect(res.body.name).toBe('Sub Point of Sale');
        expect(res.body.balance).toBe(50);
        // Pricing levels are internal and must never be exposed to customers.
        expect(res.body.tier).toBeUndefined();
        expect(res.body.baseExchangeRate).toBe(6.45);
        expect(res.body.exchangeRate).toBe(6.35); // 6.45 - 0.10 customMargin
        expect(res.body.serviceRates.vodafone).toBe(6.35);
        expect(res.body.serviceRates.post_account).toBe(6.30); // 6.35 - 0.05
        expect(res.body.serviceRates.post_card).toBe(6.20); // 6.35 - 0.15
        expect(res.body.serviceRates.bank_account).toBe(6.25);
        expect(res.body.serviceRates.sefa_niger).toBe(15.10);
        expect(res.body.serviceRates.bankak_sudan).toBe(6.55);
        expect(res.body.serviceCatalog.map(service => service.key).sort()).toEqual([
            'bank_account',
            'bankak_sudan',
            'post_account',
            'post_card',
            'sefa_niger',
            'vodafone'
        ]);
        
        expect(res.body.persona).toBe('agentClient');
        expect(res.body.role).toBe('client');
        expect(res.body.permissions).toContain('client.transfer.create');
        expect(res.body.creditLimit).toBe(100);
        expect(res.body.debt).toBe(0);
        expect(res.body.availableToSpend).toBe(150);

        expect(res.body.context.subAccountId).toBe('sub-account-id-123');
        expect(res.body.context.agentId).toBe('master-agent-id-123');
        expect(res.body.context.agentName).toBe('Master Agent');
        expect(res.body.context.masterName).toBe('Master Agent');

        // verify exclusions
        expect(res.body.webPassword).toBeUndefined();
        expect(res.body.masterId).toBeUndefined();
        expect(res.body.masterType).toBeUndefined();
    });

    it('should keep sub_client login stable when optional legacy numeric fields are missing', async () => {
        const mockSub = {
            _id: 'sub-account-id-legacy',
            masterType: 'user',
            masterId: 'master-agent-id-123',
            name: 'Legacy Sub Point',
            phone: '01033333333',
            webUsername: 'legacy-subpos',
            webPassword: '$2b$12$hashed',
            status: 'active'
        };

        const mockMaster = {
            _id: 'master-agent-id-123',
            name: 'Master Agent',
            phone: '01011111111',
            role: 'agent',
            tier: 2,
            balance: 500,
            status: 'active'
        };

        SubAccount.findOne.mockResolvedValue(mockSub);
        SubAccount.findById.mockResolvedValue(mockSub);
        User.findById.mockResolvedValue(mockMaster);

        const res = await request(app)
            .post('/api/mobile/login')
            .send({
                username: 'legacy-subpos',
                password: 'subpassword'
            })
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.accountType).toBe('sub_client');
        expect(res.body.persona).toBe('agentClient');
        expect(res.body.balance).toBe(0);
        expect(res.body.exchangeRate).toBe(6.45);
        expect(res.body.serviceRates).toEqual({
            vodafone: 6.45,
            post_account: 6.40,
            post_card: 6.30,
            bank_account: 6.35,
            sefa_niger: 15,
            bankak_sudan: 6.65
        });
        expect(res.body.creditLimit).toBe(0);
        expect(res.body.debt).toBe(0);
        expect(res.body.availableToSpend).toBe(0);
    });

    it('should fail login if sub_client is banned', async () => {
        const mockSub = {
            _id: 'sub-account-id-123',
            masterType: 'user',
            masterId: 'master-agent-id-123',
            name: 'Sub Point of Sale',
            phone: '01022222222',
            webUsername: 'subpos',
            webPassword: '$2b$12$hashed',
            customMargin: 0.10,
            creditLimit: 100,
            balance: 50,
            status: 'banned'
        };

        SubAccount.findOne.mockResolvedValue(mockSub);

        const res = await request(app)
            .post('/api/mobile/login')
            .send({
                username: 'subpos',
                password: 'subpassword'
            })
            .expect(403);

        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe('ACCOUNT_BANNED');
    });
});
