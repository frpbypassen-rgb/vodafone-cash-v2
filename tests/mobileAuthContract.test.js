// tests/mobileAuthContract.test.js
// ===============================================
// 🧪 Contract Tests — المصادقة (Auth Contract)
// ===============================================
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
    M.updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    M.modelName = 'Employee';
    return M;
});

jest.mock('../models/ClientEmployee', () => {
    const M = jest.fn();
    M.findOne = jest.fn();
    M.findById = jest.fn();
    M.updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    M.modelName = 'ClientEmployee';
    return M;
});

jest.mock('../models/ClientCompany', () => {
    const M = jest.fn();
    M.findById = jest.fn();
    return M;
});

jest.mock('../models/AgentEmployee', () => {
    const M = jest.fn();
    M.findOne = jest.fn();
    M.findById = jest.fn();
    M.updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    M.modelName = 'AgentEmployee';
    return M;
});

jest.mock('../models/SubAccount', () => {
    const M = jest.fn();
    M.findOne = jest.fn();
    M.findById = jest.fn();
    M.updateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });
    M.modelName = 'SubAccount';
    return M;
});

jest.mock('../models/Settings', () => ({
    findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
            rateLevel1: 6.40,
            rateLevel2: 6.45,
            rateLevel3: 6.50,
            isManualClosed: false
        })
    })
}));

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

jest.mock('bcryptjs', () => ({
    compare: jest.fn().mockResolvedValue(true),
    hash: jest.fn().mockResolvedValue('$2b$12$hashed')
}));

jest.mock('express-rate-limit', () => () => (req, res, next) => next());

const User = require('../models/User');
const Employee = require('../models/Employee');
const ClientEmployee = require('../models/ClientEmployee');
const ClientCompany = require('../models/ClientCompany');
const AgentEmployee = require('../models/AgentEmployee');
const bcrypt = require('bcryptjs');

const RAW_RESPONSE_FIELDS = new Set([
    'webPassword',
    'password',
    'companyId',
    'operatorId',
    'userId',
    'botId',
    'proofImage',
    'proofImages',
    '__v'
]);

const scanRawResponseFields = (obj, path = '') => {
    const found = [];
    if (!obj || typeof obj !== 'object') return found;

    for (const key of Object.keys(obj)) {
        const nextPath = path ? `${path}.${key}` : key;
        const isAllowedExecutorContext = nextPath === 'context.executorBotId';
        if (RAW_RESPONSE_FIELDS.has(key) && !isAllowedExecutorContext) {
            found.push(nextPath);
        }
        found.push(...scanRawResponseFields(obj[key], nextPath));
    }

    return found;
};

const app = express();
app.use(express.json());
app.use(require('../routes/mobileApi'));

describe('🔐 Contract Tests: Auth (Mobile API)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        Employee.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(null) });
        ClientEmployee.findOne.mockResolvedValue(null);
        AgentEmployee.findOne.mockResolvedValue(null);
        User.findOne.mockResolvedValue(null);
        ClientCompany.findById.mockResolvedValue(null);
        bcrypt.compare.mockResolvedValue(true);
    });

    test('T014 & T015: POST /login should return official contract fields (token, exchangeRate, flat user info)', async () => {
        const mockUser = {
            _id: 'user-id-123',
            name: 'Client User',
            phone: '01012345678',
            balance: 1500,
            status: 'active',
            tier: 1,
            webPassword: '$2b$12$hashed',
            save: jest.fn().mockResolvedValue(true),
            toObject: jest.fn().mockReturnThis()
        };

        User.findOne.mockResolvedValue(mockUser);

        const res = await request(app)
            .post('/login')
            .send({ username: '01012345678', password: 'password123' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.token).toBeDefined();
        expect(res.body.refreshToken).toBeDefined();
        expect(res.body.id).toBe('user-id-123');
        expect(res.body.accountType).toBe('client_user');
        expect(res.body.name).toBe('Client User');
        expect(res.body.balance).toBe(1500);
        expect(res.body.exchangeRate).toBe(6.40);
        expect(res.body.isOpen).toBe(true);
        expect(res.body.serverTime).toBeDefined();
        expect(res.body.persona).toBe('directClient');
        expect(res.body.role).toBe('client');
        expect(res.body.permissions).toEqual(expect.arrayContaining([
            'client.home.read',
            'client.transfer.create',
            'client.transactions.read',
            'client.tickets.manage'
        ]));
        expect(res.body.context).toBeDefined();
        expect(res.body.context.clientCompanyId).toBeNull();
        expect(res.body.context.agentId).toBeNull();

        // T016: Should NOT return webPassword, password, or direct credentials
        expect(res.body.webPassword).toBeUndefined();
        expect(res.body.password).toBeUndefined();
        expect(res.body.accessToken).toBeUndefined(); // Obsolete field replaced by token
        expect(scanRawResponseFields(res.body)).toEqual([]);
    });

    test('T014 & T015: POST /login should return official client_company context without raw company ids', async () => {
        const mockEmployee = {
            _id: 'company-employee-id',
            name: 'Company Employee',
            phone: '01022222222',
            status: 'active',
            companyId: 'company-id-123',
            canViewAllReports: true,
            webPassword: '$2b$12$hashed'
        };
        const mockCompany = {
            _id: 'company-id-123',
            name: 'Ahram Company',
            balance: 25000,
            tier: 2
        };

        ClientEmployee.findOne.mockResolvedValue(mockEmployee);
        ClientCompany.findById.mockResolvedValue(mockCompany);

        const res = await request(app)
            .post('/login')
            .send({ username: 'company-employee', password: 'password123' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.accountType).toBe('client_company');
        expect(res.body.id).toBe('company-employee-id');
        expect(res.body.name).toBe('Company Employee');
        expect(res.body.balance).toBe(25000);
        expect(res.body.exchangeRate).toBe(6.45);
        expect(res.body.persona).toBe('companyOwner');
        expect(res.body.role).toBe('owner');
        expect(res.body.permissions).toEqual(expect.arrayContaining([
            'company.dashboard.read',
            'company.employees.create',
            'company.reports.read_all'
        ]));
        expect(res.body.context.clientCompanyId).toBe('company-id-123');
        expect(res.body.context.clientCompanyName).toBe('Ahram Company');
        expect(res.body.companyId).toBeUndefined();
        expect(scanRawResponseFields(res.body)).toEqual([]);
    });

    test('POST /login should return companyAccountant persona for accountant company employees', async () => {
        const mockEmployee = {
            _id: 'company-accountant-id',
            name: 'Company Accountant',
            phone: '01022222223',
            status: 'active',
            companyId: 'company-id-123',
            role: 'accountant',
            canViewAllReports: true,
            webPassword: '$2b$12$hashed'
        };
        const mockCompany = {
            _id: 'company-id-123',
            name: 'Ahram Company',
            balance: 25000,
            tier: 2
        };

        ClientEmployee.findOne.mockResolvedValue(mockEmployee);
        ClientCompany.findById.mockResolvedValue(mockCompany);

        const res = await request(app)
            .post('/login')
            .send({ username: 'company-accountant', password: 'password123' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.accountType).toBe('client_company');
        expect(res.body.persona).toBe('companyAccountant');
        expect(res.body.role).toBe('accountant');
        expect(res.body.permissions).toEqual(expect.arrayContaining([
            'company.dashboard.read',
            'company.reports.read',
            'company.reports.read_all'
        ]));
        expect(res.body.permissions).not.toContain('company.employees.create');
        expect(res.body.context.clientCompanyId).toBe('company-id-123');
        expect(scanRawResponseFields(res.body)).toEqual([]);
    });

    test('POST /login should return companyManager persona without staff creation for delegated managers', async () => {
        const mockEmployee = {
            _id: 'company-manager-id',
            name: 'Company Operations Manager',
            phone: '01022222224',
            status: 'active',
            companyId: 'company-id-123',
            role: 'employee',
            canViewAllReports: true,
            canManageCompany: true,
            canCreateCompanyStaff: false,
            webPassword: '$2b$12$hashed'
        };
        const mockCompany = {
            _id: 'company-id-123',
            name: 'Ahram Company',
            balance: 25000,
            tier: 2
        };

        ClientEmployee.findOne.mockResolvedValue(mockEmployee);
        ClientCompany.findById.mockResolvedValue(mockCompany);

        const res = await request(app)
            .post('/login')
            .send({ username: 'company-manager', password: 'password123' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.persona).toBe('companyManager');
        expect(res.body.role).toBe('manager');
        expect(res.body.permissions).toEqual(expect.arrayContaining([
            'company.dashboard.read',
            'company.employees.read',
            'company.reports.read_all'
        ]));
        expect(res.body.permissions).not.toContain('company.employees.create');
        expect(scanRawResponseFields(res.body)).toEqual([]);
    });

    test('T014 & T015: POST /login should return official executor context only under context', async () => {
        const mockExecutor = {
            _id: 'executor-id-123',
            name: 'Executor Employee',
            phone: '01033333333',
            telegramId: '99887766',
            status: 'active',
            webPassword: '$2b$12$hashed',
            botId: {
                _id: 'executor-bot-id-123',
                name: 'Executor Bot',
                balance: 8000
            }
        };

        Employee.findOne.mockReturnValue({ populate: jest.fn().mockResolvedValue(mockExecutor) });

        const res = await request(app)
            .post('/login')
            .send({ username: 'executor-user', password: 'password123' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.accountType).toBe('executor');
        expect(res.body.id).toBe('executor-id-123');
        expect(res.body.name).toBe('Executor Employee');
        expect(res.body.balance).toBe(8000);
        expect(res.body.persona).toBe('executor');
        expect(res.body.role).toBe('executor');
        expect(res.body.permissions).toEqual(expect.arrayContaining([
            'executor.tasks.read',
            'executor.tasks.accept',
            'executor.tasks.complete'
        ]));
        expect(res.body.context.executorBotId).toBe('executor-bot-id-123');
        expect(res.body.context.executorBotName).toBe('Executor Bot');
        expect(res.body.botId).toBeUndefined();
        expect(scanRawResponseFields(res.body)).toEqual([]);
    });

    test('POST /login should return official agent owner persona for client_user agent accounts', async () => {
        const mockAgent = {
            _id: 'agent-user-id-123',
            name: 'Agent Owner',
            phone: '01055555555',
            balance: 5000,
            status: 'active',
            tier: 2,
            role: 'agent',
            agentCode: 'AGT-100',
            accountCode: 'AG-001',
            webPassword: '$2b$12$hashed',
            save: jest.fn().mockResolvedValue(true),
            toObject: jest.fn().mockReturnThis()
        };

        User.findOne.mockResolvedValue(mockAgent);

        const res = await request(app)
            .post('/login')
            .send({ username: '01055555555', password: 'password123' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.accountType).toBe('client_user');
        expect(res.body.persona).toBe('agentOwner');
        expect(res.body.role).toBe('agent');
        expect(res.body.permissions).toEqual(expect.arrayContaining([
            'agent.dashboard.read',
            'agent.sub_accounts.read',
            'agent.sub_accounts.update_credit_limit',
            'agent.sub_accounts.settle'
        ]));
        expect(res.body.context.agentId).toBe('agent-user-id-123');
        expect(res.body.context.agentName).toBe('Agent Owner');
        expect(res.body.context.agentCode).toBe('AGT-100');
        expect(scanRawResponseFields(res.body)).toEqual([]);
    });

    test('POST /login should return official agent staff persona and parent agent context', async () => {
        const mockAgentStaff = {
            _id: 'agent-staff-id-123',
            name: 'Agent Staff',
            phone: '01066666666',
            status: 'active',
            role: 'employee',
            agentId: 'agent-user-id-123',
            webPassword: '$2b$12$hashed'
        };
        const mockAgent = {
            _id: 'agent-user-id-123',
            name: 'Agent Owner',
            phone: '01055555555',
            webUsername: 'agent@ahram.com',
            balance: 5000,
            status: 'active',
            tier: 2,
            role: 'agent',
            accountCode: '1001'
        };

        AgentEmployee.findOne.mockResolvedValue(mockAgentStaff);
        User.findById.mockResolvedValue(mockAgent);

        const res = await request(app)
            .post('/login')
            .send({ username: 'agent-staff', password: 'password123' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.accountType).toBe('agent_staff');
        expect(res.body.persona).toBe('agentEmployee');
        expect(res.body.role).toBe('employee');
        expect(res.body.balance).toBe(5000);
        expect(res.body.permissions).toEqual(expect.arrayContaining([
            'agent.dashboard.read',
            'agent.reports.read_day'
        ]));
        expect(res.body.permissions).not.toContain('agent.registration_requests.review');
        expect(res.body.context.agentId).toBe('agent-user-id-123');
        expect(res.body.context.agentName).toBe('Agent Owner');
        expect(res.body.context.agentCode).toBe('1001');
        expect(scanRawResponseFields(res.body)).toEqual([]);
    });

    test('T018: POST /login invalid credentials should return unified auth error envelope', async () => {
        const res = await request(app)
            .post('/login')
            .set('X-Correlation-Id', 'corr-invalid-login')
            .send({ username: 'missing-user', password: 'password123' });

        expect(res.status).toBe(401);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe('INVALID_CREDENTIALS');
        expect(res.body.correlationId).toBe('corr-invalid-login');
        expect(res.body.token).toBeUndefined();
        expect(res.body.refreshToken).toBeUndefined();
    });

    test('T018: POST /login banned account should return ACCOUNT_BANNED envelope', async () => {
        User.findOne.mockResolvedValue({
            _id: 'banned-user-id',
            name: 'Banned User',
            phone: '01044444444',
            status: 'banned',
            tier: 1,
            webPassword: '$2b$12$hashed'
        });

        const res = await request(app)
            .post('/login')
            .set('X-Correlation-Id', 'corr-banned-login')
            .send({ username: 'banned-user', password: 'password123' });

        expect(res.status).toBe(403);
        expect(res.body.success).toBe(false);
        expect(res.body.code).toBe('ACCOUNT_BANNED');
        expect(res.body.correlationId).toBe('corr-banned-login');
        expect(res.body.token).toBeUndefined();
    });

    test('T018: repeated invalid credentials should lock the account identifier', async () => {
        for (let attempt = 0; attempt < 5; attempt++) {
            const failRes = await request(app)
                .post('/login')
                .send({ username: 'locked-user', password: 'bad-password' });
            expect(failRes.status).toBe(401);
        }

        const lockedRes = await request(app)
            .post('/login')
            .set('X-Correlation-Id', 'corr-locked-login')
            .send({ username: 'locked-user', password: 'bad-password' });

        expect(lockedRes.status).toBe(423);
        expect(lockedRes.body.success).toBe(false);
        expect(lockedRes.body.code).toBe('ACCOUNT_LOCKED');
        expect(lockedRes.body.correlationId).toBe('corr-locked-login');
    });

    test('T017: POST /refresh-token should return new token and expiresIn', async () => {
        const mockUser = {
            _id: 'user-id-123',
            name: 'Client User',
            status: 'active',
            refreshToken: 'valid-refresh-token'
        };

        const jwt = require('jsonwebtoken');
        // Mock token validation success
        jest.spyOn(jwt, 'verify').mockImplementation((token, secret, cb) => {
            cb(null, { userId: 'user-id-123', accountType: 'client_user' });
        });

        User.findById.mockResolvedValue(mockUser);

        const res = await request(app)
            .post('/refresh-token')
            .send({ refreshToken: 'valid-refresh-token' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.token).toBeDefined();
        expect(res.body.expiresIn).toBe(3600);
        expect(res.body.serverTime).toBeDefined();
    });
});
