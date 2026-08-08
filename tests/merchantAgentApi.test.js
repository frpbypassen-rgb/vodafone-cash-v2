'use strict';

const request = require('supertest');
const express = require('express');

jest.mock('../models/ClientBot', () => ({ findOne: jest.fn() }));
jest.mock('../models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../models/Settings', () => ({ findOne: jest.fn() }));
jest.mock('../models/Counter', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../models/Transaction', () => ({ create: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Ledger', () => jest.fn().mockImplementation(function Ledger(data) {
    Object.assign(this, data);
    this.save = jest.fn().mockResolvedValue(this);
}));
jest.mock('../services/autoRouteService', () => ({
    resolveAutoRouteExecutor: jest.fn(),
    applyAutoRouteFields: jest.fn(),
    enqueueAutoRouteIfNeeded: jest.fn()
}));
jest.mock('../services/transferCooldownService', () => ({
    acquireTransferCooldown: jest.fn(),
    releaseTransferCooldown: jest.fn()
}));
jest.mock('mongoose', () => ({ startSession: jest.fn() }));

const ClientBot = require('../models/ClientBot');
const User = require('../models/User');
const Settings = require('../models/Settings');
const Counter = require('../models/Counter');
const Transaction = require('../models/Transaction');
const Ledger = require('../models/Ledger');
const mongoose = require('mongoose');
const { resolveAutoRouteExecutor } = require('../services/autoRouteService');
const { acquireTransferCooldown, releaseTransferCooldown } = require('../services/transferCooldownService');
const merchantApi = require('../routes/merchantApi');

const leanResult = (value) => ({ lean: jest.fn().mockResolvedValue(value) });
const sessionLeanResult = (value) => ({
    session: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(value)
});

describe('Merchant API agent authentication', () => {
    let app;

    beforeEach(() => {
        jest.clearAllMocks();
        app = express();
        app.use(express.json());
        app.use('/api/v1/merchant', merchantApi);
        acquireTransferCooldown.mockResolvedValue({
            lock: {},
            guardFields: {
                requestOwnerKey: 'wallet:User:66a112233445566778899002',
                canonicalServiceKey: 'vodafone',
                canonicalRecipient: '01012345678'
            }
        });
        releaseTransferCooldown.mockResolvedValue(undefined);
    });

    test('accepts an active agent API key for a balance request', async () => {
        ClientBot.findOne.mockReturnValue(leanResult(null));
        User.findOne.mockReturnValue(leanResult({
            _id: '66a112233445566778899002',
            name: 'وكالة الاختبار',
            phone: '0912345678',
            webUsername: 'test-agent@ahram.com',
            role: 'agent',
            status: 'active',
            balance: 850,
            tier: 3,
            creditLimit: 150
        }));
        Settings.findOne.mockReturnValue(leanResult({ rateLevel3: 5.95 }));

        const response = await request(app)
            .get('/api/v1/merchant/balance')
            .set('x-api-key', 'agent-private-api-key');

        expect(response.status).toBe(200);
        expect(response.body).toEqual(expect.objectContaining({ status: 'success' }));
        expect(response.body.data).toEqual(expect.objectContaining({
            merchant_name: 'وكالة الاختبار',
            balance: 850,
            exchange_rate: expect.any(Number)
        }));
        expect(User.findOne).toHaveBeenCalledWith({
            apiToken: 'agent-private-api-key',
            role: 'agent',
            status: 'active'
        });
    });

    test('rejects requests without an API key before accessing account data', async () => {
        const response = await request(app).get('/api/v1/merchant/balance');

        expect(response.status).toBe(401);
        expect(response.body.status).toBe('failed');
        expect(ClientBot.findOne).not.toHaveBeenCalled();
        expect(User.findOne).not.toHaveBeenCalled();
    });

    test('records an agent API transfer against the agent wallet and ledger', async () => {
        const session = {
            startTransaction: jest.fn(),
            commitTransaction: jest.fn(),
            abortTransaction: jest.fn(),
            endSession: jest.fn()
        };
        const agent = {
            _id: '66a112233445566778899002',
            name: 'وكالة الاختبار',
            phone: '0912345678',
            webUsername: 'test-agent@ahram.com',
            role: 'agent',
            status: 'active',
            balance: 850,
            tier: 3,
            creditLimit: 100
        };

        mongoose.startSession.mockResolvedValue(session);
        ClientBot.findOne.mockReturnValue(leanResult(null));
        User.findOne.mockReturnValue(leanResult(agent));
        Settings.findOne.mockReturnValue(sessionLeanResult({ rateLevel3: 5.95 }));
        User.findOneAndUpdate.mockResolvedValue({ ...agent, balance: 681.933 });
        Counter.findOneAndUpdate.mockResolvedValue({ value: 77 });
        Transaction.create.mockImplementation(async ([transaction]) => [{ ...transaction, _id: 'tx-agent-api-1' }]);
        resolveAutoRouteExecutor.mockResolvedValue(null);

        const response = await request(app)
            .post('/api/v1/merchant/transfer')
            .set('x-api-key', 'agent-private-api-key')
            .send({ target_number: '01012345678', amount: 1000, transfer_type: 'vodafone' });

        expect(response.status).toBe(200);
        expect(response.body.data).toEqual(expect.objectContaining({
            status: 'pending',
            balance: 681.933,
            invoice_number: expect.stringMatching(/^ATT-\d{4}-0077$/)
        }));
        expect(User.findOneAndUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
                _id: agent._id,
                role: 'agent',
                status: 'active',
                balance: { $gte: 68.067 }
            }),
            { $inc: { balance: -168.067 } },
            expect.objectContaining({ new: true, session })
        );
        expect(Transaction.create).toHaveBeenCalledWith(
            [expect.objectContaining({
                userId: agent.phone,
                companyId: undefined,
                companyName: agent.name,
                costLYD: 168.067,
                requestOwnerKey: 'wallet:User:66a112233445566778899002',
                canonicalServiceKey: 'vodafone',
                canonicalRecipient: '01012345678'
            })],
            { session }
        );
        expect(Ledger).toHaveBeenCalledWith(expect.objectContaining({
            entityId: agent._id,
            entityModel: 'User',
            amount: -168.067
        }));
        expect(session.commitTransaction).toHaveBeenCalledTimes(1);
        expect(session.endSession).toHaveBeenCalledTimes(1);
    });

    test('returns a cooldown response before debiting an agent merchant', async () => {
        const agent = {
            _id: '66a112233445566778899002',
            name: 'وكالة الاختبار',
            phone: '0912345678',
            role: 'agent',
            status: 'active',
            balance: 850
        };
        const cooldownError = Object.assign(new Error('لا يمكن إعادة تحويل المبلغ نفسه إلى هذا الرقم الآن.'), {
            statusCode: 429,
            code: 'TRANSFER_COOLDOWN_ACTIVE',
            cooldownType: 'same_amount',
            retryAfterSeconds: 180,
            retryAt: '2026-08-09T12:03:00.000Z'
        });

        ClientBot.findOne.mockReturnValue(leanResult(null));
        User.findOne.mockReturnValue(leanResult(agent));
        acquireTransferCooldown.mockRejectedValueOnce(cooldownError);

        const response = await request(app)
            .post('/api/v1/merchant/transfer')
            .set('x-api-key', 'agent-private-api-key')
            .send({ target_number: '01012345678', amount: 1000, transfer_type: 'vodafone' });

        expect(response.status).toBe(429);
        expect(response.body).toMatchObject({
            status: 'failed',
            code: 'TRANSFER_COOLDOWN_ACTIVE',
            cooldown_type: 'same_amount',
            retry_after_seconds: 180,
            retry_at: '2026-08-09T12:03:00.000Z'
        });
        expect(User.findOneAndUpdate).not.toHaveBeenCalled();
        expect(Transaction.create).not.toHaveBeenCalled();
    });
});
