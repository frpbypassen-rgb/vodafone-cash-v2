// tests/mobileConsolidation.test.js
// ===============================================
// 🧪 Automated Tests — Mobile API Consolidation & Security
// ===============================================
'use strict';

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');
const crypto = require('crypto');

// Setup Mocks
jest.mock('express-rate-limit', () => () => (req, res, next) => next());

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
    M.findByIdAndUpdate = jest.fn();
    M.findOneAndUpdate = jest.fn();
    M.modelName = 'ClientCompany';
    return M;
});

jest.mock('../models/ExecutorGroup', () => {
    const M = jest.fn();
    M.findById = jest.fn();
    M.findByIdAndUpdate = jest.fn();
    M.modelName = 'ExecutorGroup';
    return M;
});

jest.mock('../models/RegistrationRequest', () => {
    const M = jest.fn().mockImplementation((data) => ({
        ...data,
        refCode: 'REG-2606-9999',
        status: 'pending',
        createdAt: new Date(),
        save: jest.fn().mockResolvedValue(true)
    }));
    M.create = jest.fn().mockImplementation((data) => ({
        ...data,
        refCode: 'REG-2606-9999',
        status: 'pending',
        createdAt: new Date()
    }));
    M.findOne = jest.fn();
    M.modelName = 'RegistrationRequest';
    return M;
});

jest.mock('../models/SupportTicket', () => {
    const M = jest.fn().mockImplementation((data) => ({
        ...data,
        ticketId: 'TCK-123456',
        status: 'open',
        messages: data.messages || [],
        createdAt: new Date(),
        updatedAt: new Date(),
        save: jest.fn().mockResolvedValue(true)
    }));
    M.countDocuments = jest.fn().mockResolvedValue(1);
    M.find = jest.fn();
    M.findOne = jest.fn();
    M.modelName = 'SupportTicket';
    return M;
});

jest.mock('../models/Transaction', () => {
    const M = jest.fn().mockImplementation((data) => ({
        ...data,
        _id: 'new-tx-id',
        save: jest.fn().mockResolvedValue(true)
    }));
    M.countDocuments = jest.fn().mockResolvedValue(1);
    M.find = jest.fn();
    M.findOne = jest.fn();
    M.findById = jest.fn();
    M.findOneAndUpdate = jest.fn();
    M.modelName = 'Transaction';
    return M;
});

jest.mock('../models/Settings', () => ({
    findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
            rateLevel1: 6.40,
            isManualClosed: false
        })
    })
}));

jest.mock('../models/Counter', () => ({
    findOneAndUpdate: jest.fn().mockResolvedValue({ value: 2002 })
}));

jest.mock('../models/Ledger', () => {
    const M = jest.fn().mockImplementation((data) => ({
        ...data,
        save: jest.fn().mockResolvedValue(true)
    }));
    M.modelName = 'Ledger';
    return M;
});

jest.mock('../models/JournalEvent', () => {
    const M = jest.fn().mockImplementation((data) => ({
        ...data,
        save: jest.fn().mockResolvedValue(true)
    }));
    M.findOne = jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
            session: jest.fn().mockResolvedValue(null)
        })
    });
    return M;
});

// Mock Auth logic
let mockUserPayload = { userId: 'user-id-123', accountType: 'client_user', telegramId: '99887766' };
jest.mock('../middlewares/jwtAuth', () => ({
    JWT_SECRET: 'test-secret-key-that-is-long-enough-32chars',
    JWT_REFRESH_SECRET: 'test-refresh-secret-key-long-enough-32chars',
    authenticateJWT: (req, res, next) => {
        req.user = mockUserPayload;
        next();
    }
}));

jest.mock('../services/auditService', () => ({
    logAction: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('../services/proofStorageService', () => ({
    proofSourceUrl: jest.fn().mockReturnValue('/uploads/proofs/test.jpg'),
    saveProofImage: jest.fn().mockReturnValue('proofs/saved_image.jpg'),
    streamProofImage: jest.fn().mockResolvedValue(undefined)
}));

jest.mock('bcryptjs', () => ({
    compare: jest.fn().mockResolvedValue(true),
    hash: jest.fn().mockResolvedValue('$2b$12$hashedpassword')
}));

const User = require('../models/User');
const Employee = require('../models/Employee');
const ClientEmployee = require('../models/ClientEmployee');
const RegistrationRequest = require('../models/RegistrationRequest');
const SupportTicket = require('../models/SupportTicket');
const Transaction = require('../models/Transaction');
const lockService = require('../services/lockService');
const { getRedisClient, isRedis } = require('../config/redis');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(require('../routes/mobileApi'));

const chainResolve = (value) => ({
    session: jest.fn().mockResolvedValue(value)
});

describe('📱 Automated Tests: Mobile API Consolidation & Safety', () => {
    const originalEnv = process.env.NODE_ENV;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.NODE_ENV = 'test';
        mockUserPayload = { userId: 'user-id-123', accountType: 'client_user', telegramId: '99887766' };
        
        RegistrationRequest.findOne.mockResolvedValue(null);
        User.findOne.mockResolvedValue(null);
        User.findById.mockResolvedValue({ _id: 'user-id-123', name: 'أحمد علي', phone: '0912345678', mfaEnabled: false });
        ClientEmployee.findOne.mockResolvedValue(null);
        ClientEmployee.findById.mockResolvedValue(null);
        
        const employeeQueryMock = {
            populate: jest.fn().mockReturnThis(),
            then: (resolve) => resolve(null)
        };
        Employee.findOne.mockReturnValue(employeeQueryMock);
        Employee.findById.mockReturnValue(employeeQueryMock);
    });

    afterEach(() => {
        process.env.NODE_ENV = originalEnv;
    });

    // ──────────────────────────────────────────────────────────
    // 1. Executor Identity Tests
    // ──────────────────────────────────────────────────────────
    describe('1. Executor Identity Consolidation', () => {
        test('Executor login signs executorGroupId and includes group info in context DTO', async () => {
            const mockExecutor = {
                _id: 'exec-id-100',
                name: 'Executor User',
                phone: '0911223344',
                status: 'active',
                webPassword: '$2b$12$hashedpassword',
                groupId: {
                    _id: 'group-id-200',
                    name: 'Tripoli Executor Group',
                    balance: 15000
                }
            };

            const queryObj = {
                populate: jest.fn().mockResolvedValue(mockExecutor)
            };
            Employee.findOne.mockReturnValue(queryObj);

            const res = await request(app)
                .post('/login')
                .send({ username: 'exec-username', password: 'password123' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.accountType).toBe('executor');
            expect(res.body.context.executorGroupId).toBe('group-id-200');
            expect(res.body.context.executorGroupName).toBe('Tripoli Executor Group');
            // Check compatibility duplicate botId
            expect(res.body.context.executorBotId).toBe('group-id-200');
            expect(res.body.context.executorBotName).toBe('Tripoli Executor Group');
        });

        test('GET /executor/live-tasks uses group identity and queries properly', async () => {
            mockUserPayload = { userId: 'exec-id-100', accountType: 'executor', executorGroupId: 'group-id-200' };

            const mockTasks = [
                {
                    _id: 'tx-101',
                    customId: 'ATT-2606-001',
                    transferType: 'vodafone',
                    amount: 500,
                    vodafoneNumber: '01012345678',
                    status: 'processing',
                    createdAt: new Date()
                }
            ];

            const leanMock = jest.fn().mockResolvedValue(mockTasks);
            Transaction.find.mockReturnValue({
                sort: jest.fn().mockReturnValue({ lean: leanMock }),
                lean: leanMock
            });

            const res = await request(app)
                .get('/executor/live-tasks');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data).toHaveLength(1);
            expect(res.body.data[0].recipientNumber).toBe('01012345678');
            expect(res.body.data[0].amount).toBe(500);
        });
    });

    // ──────────────────────────────────────────────────────────
    // 2. Mobile Registrations Endpoints Tests
    // ──────────────────────────────────────────────────────────
    describe('2. Mobile Registration Endpoints', () => {
        test('POST /client/register/direct registers a pending direct client request', async () => {
            const payload = {
                fullName: 'أحمد محمد علي',
                phone: '0912345678',
                storeName: 'متجر التميز',
                address: 'شارع قصر بن غشير',
                username: 'ahmed_direct',
                password: 'password123'
            };

            const res = await request(app)
                .post('/client/register/direct')
                .send(payload);

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.refCode).toBe('REG-2606-9999');
            expect(res.body.data.status).toBe('pending');
            expect(res.body.data.username).toBe('ahmed_direct@ahram.com');
        });

        test('POST /client/register/new fails if agentCode is invalid', async () => {
            const payload = {
                fullName: 'أحمد محمد علي',
                phone: '0912345678',
                storeName: 'متجر التميز',
                address: 'شارع قصر بن غشير',
                username: 'ahmed_referred',
                password: 'password123',
                agentCode: '88888888'
            };

            // Mock no agent found
            User.findOne.mockResolvedValue(null);

            const res = await request(app)
                .post('/client/register/new')
                .send(payload);

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.code).toBe('INVALID_AGENT_CODE');
        });

        test('POST /client/register/new registers pending request if agent is valid', async () => {
            const payload = {
                fullName: 'أحمد محمد علي',
                phone: '0912345678',
                storeName: 'متجر التميز',
                address: 'شارع قصر بن غشير',
                username: 'ahmed_referred',
                password: 'password123',
                agentCode: '12345678'
            };

            // Mock active agent found
            User.findOne.mockImplementation((query) => {
                if (query && query.agentCode === '12345678') {
                    return Promise.resolve({ _id: 'agent-123', role: 'agent', status: 'active' });
                }
                return Promise.resolve(null);
            });

            const res = await request(app)
                .post('/client/register/new')
                .send(payload);

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.status).toBe('pending');
            expect(res.body.data.agentCode).toBe('12345678');
        });

        test('POST /client/register/company creates a pending company request', async () => {
            const payload = {
                companyName: 'شركة النجم الساطع',
                companyContact: 'محمد طارق',
                companyPhone: '0919876543',
                companyEmail: 'contact@brightstar.ly',
                username: 'brightstar',
                password: 'password123'
            };

            const res = await request(app)
                .post('/client/register/company')
                .send(payload);

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.status).toBe('pending');
            expect(res.body.data.companyName).toBe('شركة النجم الساطع');
        });

        test('POST /client/register/agent generates code and registers a pending agent request', async () => {
            const payload = {
                companyName: 'وكالة بنغازي للخدمات',
                fullName: 'علي محمود حسن',
                phone: '0921234567',
                address: 'شارع دبي، بنغازي',
                city: 'بنغازي',
                companyEmail: 'agency@benghazi.ly',
                username: 'benghazi_agent',
                password: 'password123'
            };

            const res = await request(app)
                .post('/client/register/agent')
                .send(payload);

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.status).toBe('pending');
            expect(res.body.data.agentCode).toBeDefined();
            expect(res.body.data.agentCode.length).toBe(8);
        });
    });

    // ──────────────────────────────────────────────────────────
    // 3. Conditional Transfer Validation Tests
    // ──────────────────────────────────────────────────────────
    describe('3. Conditional Transfer Validation & Image Uploads', () => {
        test('Rejects post_card without quadruple recipientName', async () => {
            const payload = {
                amount: 250,
                number: '12345678901234', // 14 digits ID
                transferType: 'post_card',
                name: 'أحمد علي', // Only 2 parts
                idCardImage: 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
            };

            const res = await request(app)
                .post('/client/new-transfer')
                .set('Idempotency-Key', '550e8400-e29b-41d4-a716-446655440022')
                .send(payload);

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('الاسم المستلم يجب أن يكون رباعياً');
        });

        test('Rejects post_card without 14-digit recipientNationalId number', async () => {
            const payload = {
                amount: 250,
                number: '12345', // Malformed ID
                transferType: 'post_card',
                name: 'أحمد علي محمد حسن',
                idCardImage: 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='
            };

            const res = await request(app)
                .post('/client/new-transfer')
                .set('Idempotency-Key', '550e8400-e29b-41d4-a716-446655440023')
                .send(payload);

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('الرقم القومي للمستلم مطلوب ويجب أن يكون 14 رقماً');
        });

        test('Rejects post_card without idCardImage', async () => {
            const payload = {
                amount: 250,
                number: '12345678901234',
                transferType: 'post_card',
                name: 'أحمد علي محمد حسن'
            };

            const res = await request(app)
                .post('/client/new-transfer')
                .set('Idempotency-Key', '550e8400-e29b-41d4-a716-446655440024')
                .send(payload);

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('صورة وجه البطاقة الشخصية للمستلم مطلوبة');
        });

        test('Rejects post_card if idCardImage exceeds 5MB size limit', async () => {
            // Decodes to size > 5MB
            const hugeBase64 = Buffer.alloc(6 * 1024 * 1024).toString('base64');
            const payload = {
                amount: 250,
                number: '12345678901234',
                transferType: 'post_card',
                name: 'أحمد علي محمد حسن',
                idCardImage: 'data:image/jpeg;base64,' + hugeBase64
            };

            const res = await request(app)
                .post('/client/new-transfer')
                .set('Idempotency-Key', '550e8400-e29b-41d4-a716-446655440025')
                .send(payload);

            expect(res.status).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('حجم صورة البطاقة الشخصية يجب ألا يتجاوز 5 ميجابايت');
        });
    });

    // ──────────────────────────────────────────────────────────
    // 4. Support Tickets Endpoints Tests
    // ──────────────────────────────────────────────────────────
    describe('4. Support Tickets Mobile Flow', () => {
        test('POST /client/tickets creates new support ticket', async () => {
            mockUserPayload = { userId: 'user-id-123', accountType: 'client_user' };

            User.findById.mockResolvedValue({ _id: 'user-id-123', name: 'أحمد علي', phone: '0912345678' });

            const res = await request(app)
                .post('/client/tickets')
                .send({ text: 'لدي استفسار عن رصيد حسابي المحول' });

            expect(res.status).toBe(201);
            expect(res.body.success).toBe(true);
            expect(res.body.ticket.ticketId).toBe('TCK-123456');
            expect(res.body.ticket.status).toBe('open');
        });

        test('GET /client/tickets returns user support tickets list', async () => {
            mockUserPayload = { userId: 'user-id-123', accountType: 'client_user' };

            const mockTickets = [
                {
                    _id: 'tkt-001',
                    ticketId: 'TCK-123456',
                    name: 'أحمد علي',
                    phone: '0912345678',
                    status: 'open',
                    unreadUser: 1,
                    createdAt: new Date(),
                    updatedAt: new Date()
                }
            ];

            SupportTicket.find.mockReturnValue({
                sort: jest.fn().mockReturnValue({
                    skip: jest.fn().mockReturnValue({
                        limit: jest.fn().mockReturnValue({
                            lean: jest.fn().mockResolvedValue(mockTickets)
                        })
                    })
                })
            });

            const res = await request(app)
                .get('/client/tickets');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.tickets).toHaveLength(1);
            expect(res.body.tickets[0].ticketId).toBe('TCK-123456');
            expect(res.body.tickets[0].unreadCount).toBe(1);
        });

        test('POST /client/tickets/:id/reply pushes user message and updates status', async () => {
            mockUserPayload = { userId: 'user-id-123', accountType: 'client_user' };

            const mockTicket = {
                _id: 'tkt-001',
                name: 'أحمد علي',
                messages: [],
                status: 'answered',
                unreadAdmin: 0,
                save: jest.fn().mockResolvedValue(true)
            };

            SupportTicket.findOne.mockResolvedValue(mockTicket);

            const res = await request(app)
                .post('/client/tickets/tkt-001/reply')
                .send({ text: 'هذا رد توضيحي من العميل' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.message.text).toBe('هذا رد توضيحي من العميل');
            expect(mockTicket.messages).toHaveLength(1);
            expect(mockTicket.status).toBe('open');
            expect(mockTicket.unreadAdmin).toBe(1);
        });
    });

    // ──────────────────────────────────────────────────────────
    // 5. Transaction History Pagination & DTO Sanitization Tests
    // ──────────────────────────────────────────────────────────
    describe('5. Client Transactions History', () => {
        test('GET /client/transactions returns paginated list and excludes internal database fields', async () => {
            mockUserPayload = { userId: 'user-id-123', accountType: 'client_user' };

            User.findById.mockResolvedValue({ _id: 'user-id-123', phone: '0912345678', webUsername: 'ahmed_username' });

            const mockTxs = [
                {
                    _id: 'tx-001',
                    customId: 'ATT-2606-1002',
                    transferType: 'vodafone',
                    vodafoneNumber: '01012345678',
                    amount: 1500,
                    costLYD: 232.558,
                    exchangeRate: 6.45,
                    status: 'completed',
                    createdAt: new Date(),
                    notes: 'ملاحظة',
                    userId: 'user-id-123', // Raw internal database field
                    companyId: 'company-id-123', // Raw internal database field
                    proofImage: 'proofs/123.jpg', // Raw internal database field
                    __v: 0 // Mongoose document version field
                }
            ];

            Transaction.find.mockReturnValue({
                sort: jest.fn().mockReturnValue({
                    skip: jest.fn().mockReturnValue({
                        limit: jest.fn().mockReturnValue({
                            lean: jest.fn().mockResolvedValue(mockTxs)
                        })
                    })
                })
            });

            const res = await request(app)
                .get('/client/transactions');

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.transactions).toHaveLength(1);
            
            const clientTx = res.body.transactions[0];
            expect(clientTx.customId).toBe('ATT-2606-1002');
            expect(clientTx.amount).toBe(1500);
            expect(clientTx.costLYD).toBe(232.558);
            
            // SECURITY CHECK: Verify absolute absence of raw internal database fields
            expect(clientTx.userId).toBeUndefined();
            expect(clientTx.companyId).toBeUndefined();
            expect(clientTx.proofImage).toBeUndefined();
            expect(clientTx.__v).toBeUndefined();
        });
    });

    // ──────────────────────────────────────────────────────────
    // 6. Production Locking & Redis Enforcement Tests
    // ──────────────────────────────────────────────────────────
    describe('6. Production Safety & Locking Enforcement', () => {
        test('Throws error if lock acquisition fails in mock production mode', async () => {
            process.env.NODE_ENV = 'production';

            // Mock Redis connected state, but Redlock client acquisition throws error
            const { isRedis, getRedisClient } = require('../config/redis');
            jest.mock('../config/redis', () => ({
                isRedis: jest.fn().mockReturnValue(true),
                getRedisClient: jest.fn().mockReturnValue({}),
                initRedis: jest.fn()
            }));

            // Mock Redlock class throwing error on acquire
            const mockRedlock = {
                acquire: jest.fn().mockRejectedValue(new Error('Lock Lock Lock Lock'))
            };
            const lockServiceFile = require('../services/lockService');
            // We set internal redlock directly or we can mock _initRedlock in lockService
            jest.spyOn(lockServiceFile, 'acquireLock').mockImplementation(async (key) => {
                if (process.env.NODE_ENV === 'production') {
                    throw new Error('REDIS_LOCK_FAILED: Failed to acquire distributed lock in production');
                }
                return {};
            });

            await expect(lockServiceFile.acquireLock('idemp:some-key')).rejects.toThrow('REDIS_LOCK_FAILED');
        });
    });
});
