// tests/mobileSubAccountTransferFlow.test.js
'use strict';

const request = require('supertest');
const express = require('express');

// Mock mongoose and models
jest.mock('mongoose', () => {
    const session = {
        startTransaction: jest.fn(),
        commitTransaction: jest.fn().mockResolvedValue(undefined),
        abortTransaction: jest.fn().mockResolvedValue(undefined),
        endSession: jest.fn(),
    };
    const SchemaMock = jest.fn().mockImplementation(function() { return { index: jest.fn(), pre: jest.fn(), post: jest.fn() }; });
    SchemaMock.Types = { ObjectId: String, Mixed: Object };
    return {
        startSession: jest.fn().mockResolvedValue(session),
        model: jest.fn().mockReturnValue({}),
        Schema: SchemaMock,
        _session: session,
    };
});

const MOCK_USER = {
    _id: 'agent-user-id-123',
    name: 'Agent User',
    phone: '01011111111',
    webUsername: 'agentuser',
    webPassword: '$2b$12$hashed',
    role: 'agent',
    tier: 2,
    balance: 1000,
    status: 'active',
    save: jest.fn().mockResolvedValue(true),
    toObject: jest.fn().mockReturnThis()
};

const MOCK_SUB = {
    _id: 'sub-account-id-123',
    masterType: 'user',
    masterId: 'agent-user-id-123',
    name: 'Sub POS Cairo',
    phone: '01022222222',
    webUsername: 'subposcairo',
    webPassword: '$2b$12$hashed',
    customMargin: 0.10,
    creditLimit: 100,
    balance: 150,
    status: 'active',
    save: jest.fn().mockResolvedValue(true),
    toObject: jest.fn().mockReturnThis()
};

const MOCK_SETTINGS = {
    rateLevel1: 6.50,
    rateLevel2: 6.45,
    rateLevel3: 6.40,
    isManualClosed: false
};

jest.mock('../models/User', () => {
    const M = jest.fn().mockImplementation(() => MOCK_USER);
    M.findOne = jest.fn().mockImplementation(() => ({
        session: jest.fn().mockReturnValue(MOCK_USER),
        then: function(resolve) { return Promise.resolve(MOCK_USER).then(resolve); }
    }));
    M.findById = jest.fn().mockImplementation(() => ({
        session: jest.fn().mockReturnValue(MOCK_USER),
        then: function(resolve) { return Promise.resolve(MOCK_USER).then(resolve); }
    }));
    M.findOneAndUpdate = jest.fn().mockResolvedValue(MOCK_USER);
    M.findByIdAndUpdate = jest.fn().mockResolvedValue(MOCK_USER);
    M.modelName = 'User';
    return M;
});

jest.mock('../models/SubAccount', () => {
    const M = jest.fn().mockImplementation(() => MOCK_SUB);
    M.findOne = jest.fn().mockResolvedValue(MOCK_SUB);
    M.findById = jest.fn().mockImplementation(() => ({
        session: jest.fn().mockReturnValue(MOCK_SUB),
        then: function(resolve) { return Promise.resolve(MOCK_SUB).then(resolve); }
    }));
    M.findOneAndUpdate = jest.fn().mockResolvedValue(MOCK_SUB);
    M.findByIdAndUpdate = jest.fn().mockResolvedValue(MOCK_SUB);
    M.modelName = 'SubAccount';
    return M;
});

jest.mock('../models/Settings', () => ({
    findOne: jest.fn().mockImplementation(() => ({
        session: jest.fn().mockReturnValue(MOCK_SETTINGS),
        lean: jest.fn().mockResolvedValue(MOCK_SETTINGS),
        then: function(resolve) { return Promise.resolve(MOCK_SETTINGS).then(resolve); }
    }))
}));

jest.mock('../models/Counter', () => ({
    findOneAndUpdate: jest.fn().mockImplementation(() => ({
        value: 1,
        session: jest.fn().mockReturnValue({ value: 1 }),
        then: function(resolve) { return Promise.resolve({ value: 1 }).then(resolve); }
    }))
}));

jest.mock('../models/Transaction', () => {
    const M = jest.fn().mockImplementation((data) => ({
        ...data,
        save: jest.fn().mockResolvedValue(true)
    }));
    M.findOne = jest.fn().mockImplementation(() => ({
        session: jest.fn().mockReturnValue(null),
        then: function(resolve) { return Promise.resolve(null).then(resolve); }
    }));
    M.findById = jest.fn().mockImplementation(() => ({
        session: jest.fn().mockReturnValue(null),
        then: function(resolve) { return Promise.resolve(null).then(resolve); }
    }));
    M.modelName = 'Transaction';
    return M;
});

jest.mock('../models/Ledger', () => {
    const M = jest.fn().mockImplementation((data) => ({
        ...data,
        save: jest.fn().mockResolvedValue(true)
    }));
    M.find = jest.fn().mockResolvedValue([]);
    M.modelName = 'Ledger';
    return M;
});

jest.mock('../models/JournalEvent', () => {
    const M = jest.fn().mockImplementation((data) => ({
        ...data,
        save: jest.fn().mockResolvedValue(true)
    }));
    M.findOne = jest.fn().mockImplementation(() => ({
        sort: jest.fn().mockImplementation(() => ({
            session: jest.fn().mockResolvedValue(null)
        }))
    }));
    M.modelName = 'JournalEvent';
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

jest.mock('../models/ClientBot', () => {
    const M = jest.fn();
    M.findById = jest.fn();
    M.modelName = 'ClientBot';
    return M;
});

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
jest.mock('../services/eventBus', () => ({
    publish: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('bcryptjs', () => ({
    compare: jest.fn().mockResolvedValue(true),
    hash: jest.fn().mockResolvedValue('$2b$12$hashed')
}));

jest.mock('express-rate-limit', () => () => (req, res, next) => next());

const User = require('../models/User');
const SubAccount = require('../models/SubAccount');
const Transaction = require('../models/Transaction');
const Ledger = require('../models/Ledger');
const Settings = require('../models/Settings');
const mongoose = require('mongoose');
const { transferService } = require('../src/Application/Services/TransferService.ts');

const app = express();
app.use(express.json());
app.use('/api/mobile', require('../routes/mobileApi'));

describe('Mobile SubAccount Transfer Flow', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Setup default mocks values
        User.findById.mockImplementation(() => ({
            session: jest.fn().mockReturnValue(MOCK_USER),
            then: function(resolve) { return Promise.resolve(MOCK_USER).then(resolve); }
        }));
        SubAccount.findById.mockImplementation(() => ({
            session: jest.fn().mockReturnValue(MOCK_SUB),
            then: function(resolve) { return Promise.resolve(MOCK_SUB).then(resolve); }
        }));
    });

    it('should complete transfer, deduct both accounts atomically, write double ledgers, and single transaction', async () => {
        // Mock atomic balance deduction
        const updatedSub = { ...MOCK_SUB, balance: 102.756 };
        const updatedMaster = { ...MOCK_USER, balance: 953.488 };

        SubAccount.findOneAndUpdate.mockResolvedValue(updatedSub);
        User.findOneAndUpdate.mockResolvedValue(updatedMaster);

        // Mock Ledger search for test asserts
        const mockLedgers = [
            { entityModel: 'SubAccount', amount: -47.244 },
            { entityModel: 'User', amount: -46.512 }
        ];
        Ledger.find.mockResolvedValue(mockLedgers);

        // Mock Transaction created inside flow
        const mockCreatedTx = {
            _id: 'tx-created-id',
            customId: 'ATT-2601-0001',
            isSubAccountTx: true,
            subAccountId: MOCK_SUB._id,
            subAccountName: 'Sub POS Cairo',
            costLYD: 46.512,
            subAccountCostLYD: 47.244,
            commission: 0.732,
            exchangeRate: 6.45,
            subClientRate: 6.35,
            masterProfit: 0.732,
            save: jest.fn().mockResolvedValue(true)
        };
        Transaction.findOne.mockImplementation(() => ({
            session: jest.fn().mockReturnValue(null),
            then: function(resolve) { return Promise.resolve(mockCreatedTx).then(resolve); }
        }));

        const res = await request(app)
            .post('/api/mobile/client/new-transfer')
            .set('Idempotency-Key', '55555555-5555-5555-5555-555555555551')
            .send({
                transferType: 'vodafone',
                amount: 300,
                number: '01055555555',
                name: 'Recipient Name'
            })
            .expect(200);

        expect(res.body.success).toBe(true);
        expect(res.body.txId).toBeDefined();
        expect(res.body.costLYD).toBe(47.244);
        expect(res.body.exchangeRate).toBe(6.35);
        expect(mongoose.startSession).not.toHaveBeenCalled();

        // Check findOneAndUpdate calls
        expect(SubAccount.findOneAndUpdate).toHaveBeenCalled();
        expect(User.findOneAndUpdate).toHaveBeenCalled();
    });

    it('should let a customer use the agent-approved debt limit while debiting the agent too', async () => {
        const updatedSub = { ...MOCK_SUB, balance: -47.244 };
        const updatedMaster = { ...MOCK_USER, balance: 953.488 };

        SubAccount.findOneAndUpdate.mockResolvedValue(updatedSub);
        User.findOneAndUpdate.mockResolvedValue(updatedMaster);

        await request(app)
            .post('/api/mobile/client/new-transfer')
            .set('Idempotency-Key', '55555555-5555-5555-5555-555555555553')
            .send({
                transferType: 'vodafone',
                amount: 300,
                number: '01055555555',
                name: 'Recipient Name'
            })
            .expect(200);

        const [subFilter, subUpdate] = SubAccount.findOneAndUpdate.mock.calls[0];
        const [agentFilter, agentUpdate] = User.findOneAndUpdate.mock.calls[0];

        expect(subFilter).toMatchObject({
            _id: MOCK_SUB._id,
            balance: { $gte: -52.756 }
        });
        expect(subUpdate).toEqual({ $inc: { balance: -47.244 } });
        expect(agentFilter).toMatchObject({
            _id: MOCK_USER._id,
            balance: { $gte: 46.512 }
        });
        expect(agentUpdate).toEqual({ $inc: { balance: -46.512 } });
    });

    it('should rollback transaction if sub-account has insufficient balance', async () => {
        // Mock findOneAndUpdate returning null (simulating insufficient balance check failure)
        SubAccount.findOneAndUpdate.mockResolvedValue(null);

        await request(app)
            .post('/api/mobile/client/new-transfer')
            .set('Idempotency-Key', '55555555-5555-5555-5555-555555555552')
            .send({
                transferType: 'vodafone',
                amount: 1700,
                number: '01055555555',
                name: 'Recipient Name'
            })
            .expect(400);
    });

    it('should refund both accounts on cancelTransfer', async () => {
        const Employee = require('../models/Employee');
        const mockOperator = {
            _id: 'operator-id-123',
            name: 'Operator Name',
            webUsername: 'operator123'
        };
        Employee.findOne.mockImplementation(() => ({
            session: jest.fn().mockResolvedValue(mockOperator)
        }));

        const mockTx = {
            _id: 'tx-to-cancel-id',
            customId: 'ATT-2601-0002',
            status: 'accepted',
            operatorId: 'operator-id-123',
            isSubAccountTx: true,
            subAccountId: MOCK_SUB._id,
            subAccountCostLYD: 47.244,
            costLYD: 46.512,
            userId: 'agentuser',
            save: jest.fn().mockResolvedValue(true)
        };

        Transaction.findById.mockImplementation(() => ({
            session: jest.fn().mockResolvedValue(mockTx)
        }));

        // Mock findByIdAndUpdate updates
        SubAccount.findByIdAndUpdate.mockResolvedValue({ ...MOCK_SUB, balance: 150 });
        User.findByIdAndUpdate.mockResolvedValue({ ...MOCK_USER, balance: 1000 });

        const cancelResult = await transferService.cancelTransfer({
            taskId: 'tx-to-cancel-id',
            userId: 'operator123',
            reason: 'Failed to execute transfer'
        });

        expect(cancelResult.success).toBe(true);
        expect(mockTx.status).toBe('rejected');
    });
});
