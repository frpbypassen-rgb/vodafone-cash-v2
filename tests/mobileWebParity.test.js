// tests/mobileWebParity.test.js
'use strict';

const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

// Mocks
jest.mock('express-rate-limit', () => () => (req, res, next) => next());

jest.mock('../models/User', () => {
    const M = jest.fn();
    M.findOne = jest.fn();
    M.findById = jest.fn();
    M.findByIdAndUpdate = jest.fn();
    M.findOneAndUpdate = jest.fn();
    M.modelName = 'User';
    return M;
});

jest.mock('../models/Employee', () => {
    const M = jest.fn();
    M.findOne = jest.fn();
    M.findById = jest.fn();
    M.findByIdAndUpdate = jest.fn();
    M.create = jest.fn();
    M.findByIdAndDelete = jest.fn();
    M.find = jest.fn();
    M.modelName = 'Employee';
    return M;
});

jest.mock('../models/ExecutorGroup', () => {
    const M = jest.fn();
    M.findById = jest.fn();
    M.findOneAndUpdate = jest.fn();
    M.modelName = 'ExecutorGroup';
    return M;
});

jest.mock('../models/ClientEmployee', () => {
    const M = jest.fn();
    M.findOne = jest.fn();
    M.findById = jest.fn();
    M.modelName = 'ClientEmployee';
    return M;
});

jest.mock('../models/ClientCompany', () => {
    const M = jest.fn();
    M.findById = jest.fn();
    M.findOne = jest.fn();
    M.findByIdAndUpdate = jest.fn();
    M.findOneAndUpdate = jest.fn();
    M.modelName = 'ClientCompany';
    return M;
});

jest.mock('../models/SubAccount', () => {
    const M = jest.fn();
    M.findById = jest.fn();
    M.findOne = jest.fn();
    M.findOneAndUpdate = jest.fn();
    M.modelName = 'SubAccount';
    return M;
});

jest.mock('../models/Transaction', () => {
    const M = jest.fn().mockImplementation((data) => ({
        ...data,
        save: jest.fn().mockResolvedValue(true)
    }));
    M.countDocuments = jest.fn().mockResolvedValue(1);
    M.find = jest.fn();
    M.findOne = jest.fn();
    M.findById = jest.fn();
    M.create = jest.fn().mockResolvedValue([]);
    M.deleteMany = jest.fn().mockResolvedValue({});
    M.modelName = 'Transaction';
    return M;
});

jest.mock('../models/Ledger', () => {
    const M = jest.fn();
    M.create = jest.fn().mockResolvedValue([]);
    M.deleteMany = jest.fn().mockResolvedValue({});
    M.modelName = 'Ledger';
    return M;
});

jest.mock('../models/Counter', () => ({
    findOneAndUpdate: jest.fn().mockResolvedValue({ value: 101 })
}));

jest.mock('../models/SupportTicket', () => {
    const M = jest.fn().mockImplementation((data) => ({
        ...data,
        ticketId: 'TCK-111111',
        status: 'open',
        messages: data.messages || [],
        save: jest.fn().mockResolvedValue(true)
    }));
    M.findOne = jest.fn();
    M.modelName = 'SupportTicket';
    return M;
});

jest.mock('../models/Admin', () => ({
    find: jest.fn().mockResolvedValue([{ webUsername: 'admin' }])
}));

jest.mock('../models/Notification', () => ({
    create: jest.fn().mockResolvedValue({})
}));

jest.mock('../models/AccountCode', () => ({
    findOne: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(null)
    }),
    modelName: 'AccountCode'
}));

// Mock lockService to pass immediately
jest.mock('../services/lockService', () => ({
    acquireLock: jest.fn().mockResolvedValue({ lockId: 'mock-lock-id' }),
    releaseLock: jest.fn().mockResolvedValue(true)
}));

jest.mock('../services/accountCodeService', () => ({
    resolveAccountByCode: jest.fn(),
    normalizeAccountCode: (code) => String(code).trim()
}));

const mockZaynPayInquiry = jest.fn();
const mockZaynPayPay = jest.fn();
jest.mock('../services/zaynpayApi', () => ({
    inquiry: (...args) => mockZaynPayInquiry(...args),
    pay: (...args) => mockZaynPayPay(...args)
}));

jest.mock('../utils/receiptGenerator', () => ({
    generateReceiptBase64: jest.fn().mockResolvedValue(
        `data:image/jpeg;base64,${Buffer.from('receipt').toString('base64')}`
    )
}));

jest.mock('../services/balanceTransferReceiptService', () => ({
    createBalanceTransferReceiptProof: jest.fn().mockReturnValue('proofs/BTR-test_balance_transfer_receipt.svg')
}));

// Mock audit service to prevent crashes and verify no password leaking
const mockLogAction = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/auditService', () => ({
    logAction: mockLogAction
}));

// Authenticated user payload control
let testUserPayload = { userId: 'user-id-123', accountType: 'client_user' };
jest.mock('../middlewares/jwtAuth', () => ({
    JWT_SECRET: 'test-secret-key-that-is-long-enough-32chars',
    JWT_REFRESH_SECRET: 'test-refresh-secret-key-long-enough-32chars',
    authenticateJWT: (req, res, next) => {
        req.user = testUserPayload;
        next();
    }
}));

const User = require('../models/User');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const ClientEmployee = require('../models/ClientEmployee');
const ClientCompany = require('../models/ClientCompany');
const SubAccount = require('../models/SubAccount');
const Transaction = require('../models/Transaction');
const SupportTicket = require('../models/SupportTicket');
const { createBalanceTransferReceiptProof } = require('../services/balanceTransferReceiptService');
const { executeBalanceTransfer } = require('../services/balanceTransferService');

const app = RouterApp();

function RouterApp() {
    const expressApp = express();
    expressApp.use(express.json());
    expressApp.use('/api/mobile', require('../routes/mobileApi'));
    return expressApp;
}

// Fingerprint utility helper for tests
function getFingerprint(method, path, userId, body) {
    const sortedBody = {};
    if (body && typeof body === 'object') {
        Object.keys(body).sort().forEach(key => {
            sortedBody[key] = body[key];
        });
    }
    const payload = {
        method,
        path,
        userOrAccount: userId,
        body: sortedBody
    };
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

describe('📱 Spec 014: Mobile Web Parity Bridge Tests', () => {
    
    beforeEach(() => {
        jest.clearAllMocks();
        testUserPayload = { userId: 'user-id-123', accountType: 'client_user' };
        
        // Mongoose admin replica set check mock
        mongoose.connection.db = {
            admin: () => ({
                command: jest.fn().mockResolvedValue(null) // Mock replica set check throws error / returns null (standalone mode)
            })
        };
        mongoose.startSession = jest.fn().mockResolvedValue({
            startTransaction: jest.fn(),
            commitTransaction: jest.fn().mockResolvedValue(undefined),
            abortTransaction: jest.fn().mockResolvedValue(undefined),
            endSession: jest.fn()
        });
        mockZaynPayInquiry.mockResolvedValue({ billId: 'bill-1' });
        mockZaynPayPay.mockResolvedValue({ success: true, transactionNumber: 'ZP-001', refNumber: 'REF-001' });

        // Default chainable query mocks for Transaction.find
        const leanMock = jest.fn().mockResolvedValue([]);
        const selectMock = jest.fn().mockReturnValue({ lean: leanMock });
        const sortMock = jest.fn().mockReturnValue({ lean: leanMock });
        Transaction.find.mockReturnValue({
            select: selectMock,
            sort: sortMock,
            lean: leanMock
        });
    });

    describe('🔑 Point 1: Idempotency-Key & Fingerprint Check', () => {
        test('POST /api/mobile/client/balance-transfer requires valid UUID key in header only', async () => {
            const res = await request(app)
                .post('/api/mobile/client/balance-transfer')
                .send({ targetAccountCode: '1002', amount: 50, notes: 'تحويل' });

            expect(res.status).toBe(400);
            expect(res.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
        });

        test('POST /api/mobile/client/balance-transfer returns 400 with invalid UUID format', async () => {
            const res = await request(app)
                .post('/api/mobile/client/balance-transfer')
                .set('Idempotency-Key', 'invalid-key')
                .send({ targetAccountCode: '1002', amount: 50, notes: 'تحويل' });

            expect(res.status).toBe(400);
            expect(res.body.code).toBe('VALIDATION_ERROR');
        });
    });

    describe('🔄 Point 2: executeBalanceTransfer Session Safety & Non-Nested Sessions', () => {
        test('executeBalanceTransfer reuses external session without starting transaction if provided', async () => {
            const mockSessionObj = {
                startTransaction: jest.fn(),
                commitTransaction: jest.fn(),
                abortTransaction: jest.fn(),
                endSession: jest.fn()
            };

            const sourceAccount = {
                modelName: 'User',
                doc: { _id: 'src-id', status: 'active', balance: 1000, accountCode: '1001' }
            };
            const targetAccount = {
                modelName: 'User',
                doc: { _id: 'target-id', status: 'active', balance: 500, accountCode: '1002' },
                label: 'عميل فردي'
            };

            // Setup DB mocks
            User.findOneAndUpdate = jest.fn().mockResolvedValue({ _id: 'src-id', balance: 950 });
            User.findByIdAndUpdate = jest.fn().mockResolvedValue({ _id: 'target-id', balance: 550 });
            User.findById = jest.fn().mockResolvedValue(targetAccount.doc);
            ClientCompany.findOne = jest.fn().mockResolvedValue(null);
            SubAccount.findOne = jest.fn().mockResolvedValue(null);

            // Mock resolve target helper
            const accountCodeService = require('../services/accountCodeService');
            accountCodeService.resolveAccountByCode.mockResolvedValue(targetAccount);

            await executeBalanceTransfer({
                source: sourceAccount,
                targetCode: '1002',
                amount: 50,
                notes: 'تحويل مع سشن',
                session: mockSessionObj
            });

            // Assertions
            expect(mockSessionObj.startTransaction).not.toHaveBeenCalled();
            expect(mockSessionObj.commitTransaction).not.toHaveBeenCalled();
            expect(mockSessionObj.endSession).not.toHaveBeenCalled();
            expect(User.findOneAndUpdate).toHaveBeenCalledWith(
                expect.any(Object),
                expect.any(Object),
                expect.objectContaining({ session: mockSessionObj })
            );
        });

        test('executeBalanceTransfer attaches one generated receipt to debit and credit transactions', async () => {
            const mockSessionObj = { id: 'session-1' };
            const sourceAccount = {
                modelName: 'User',
                doc: { _id: 'src-id', status: 'active', balance: 1000, accountCode: '1001', name: 'Source Client' }
            };
            const targetAccount = {
                modelName: 'User',
                doc: { _id: 'target-id', status: 'active', balance: 500, accountCode: '1002', name: 'Target Client' },
                label: 'عميل فردي'
            };

            User.findOneAndUpdate = jest.fn().mockResolvedValue({ _id: 'src-id', balance: 925 });
            User.findByIdAndUpdate = jest.fn().mockResolvedValue({ _id: 'target-id', balance: 575 });
            User.findById = jest.fn().mockResolvedValue(targetAccount.doc);

            const accountCodeService = require('../services/accountCodeService');
            accountCodeService.resolveAccountByCode.mockResolvedValue(targetAccount);

            await executeBalanceTransfer({
                source: sourceAccount,
                targetCode: '1002',
                amount: 75,
                notes: 'internal transfer',
                session: mockSessionObj
            });

            expect(createBalanceTransferReceiptProof).toHaveBeenCalledWith(expect.objectContaining({
                sourceName: 'Source Client',
                sourceCode: '1001',
                targetName: 'Target Client',
                targetCode: '1002',
                amount: 75,
                sourceBalanceBefore: 1000,
                sourceBalanceAfter: 925,
                targetBalanceBefore: 500,
                targetBalanceAfter: 575
            }));
            expect(Transaction.create).toHaveBeenCalledWith(
                [
                    expect.objectContaining({
                        customId: expect.stringMatching(/^BTR-\d{4}-0101-D$/),
                        proofImage: 'proofs/BTR-test_balance_transfer_receipt.svg',
                        proofImages: ['proofs/BTR-test_balance_transfer_receipt.svg']
                    }),
                    expect.objectContaining({
                        customId: expect.stringMatching(/^BTR-\d{4}-0101-C$/),
                        proofImage: 'proofs/BTR-test_balance_transfer_receipt.svg',
                        proofImages: ['proofs/BTR-test_balance_transfer_receipt.svg']
                    })
                ],
                expect.objectContaining({ session: mockSessionObj })
            );
        });
    });

    describe('🛡️ Point 4: Idempotency Storage (Debit-Only) and Conflict Replays', () => {
        test('Conflict (same key, different fingerprint) returns 409', async () => {
            const mockTx = {
                idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
                idempotencyFingerprint: 'fingerprint-a',
                idempotencyResponse: { success: true, transferId: 'BTR-2606-0001' }
            };
            Transaction.findOne.mockResolvedValue(mockTx);

            const res = await request(app)
                .post('/api/mobile/client/balance-transfer')
                .set('Idempotency-Key', '550e8400-e29b-41d4-a716-446655440000')
                .send({ targetAccountCode: '1002', amount: 50, notes: 'مختلف' });

            expect(res.status).toBe(409);
            expect(res.body.code).toBe('IDEMPOTENCY_CONFLICT');
        });

        test('Replay (same key, same fingerprint) returns cached response', async () => {
            const body = { targetAccountCode: '1002', amount: 50, notes: 'تكرار' };
            const expectedFingerprint = getFingerprint(
                'POST',
                '/api/mobile/client/balance-transfer',
                'user-id-123',
                body
            );

            const mockTx = {
                idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
                idempotencyFingerprint: expectedFingerprint,
                idempotencyResponse: { success: true, transferId: 'BTR-2606-0001', amount: 50, sourceBalance: 950 }
            };
            Transaction.findOne.mockResolvedValue(mockTx);

            testUserPayload = { userId: 'user-id-123', accountType: 'client_user' };

            const res = await request(app)
                .post('/api/mobile/client/balance-transfer')
                .set('Idempotency-Key', '550e8400-e29b-41d4-a716-446655440000')
                .send(body);

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.transferId).toBe('BTR-2606-0001');
            expect(res.body.amount).toBe(50);
        });
    });

    describe('🔐 Point 5: Secure reset employee password', () => {
        test('resetEmployeePassword endpoint does not return plain-text/hash and excludes it from logs', async () => {
            testUserPayload = { userId: 'manager-id', accountType: 'executor' };

            const mockManager = { _id: 'manager-id', role: 'manager', groupId: 'group-id-123' };
            const mockEmp = { _id: 'emp-id', role: 'operator', groupId: 'group-id-123', webUsername: 'operator@ahram.com', save: jest.fn().mockResolvedValue(true) };
            
            Employee.findById.mockImplementation((id) => {
                if (id === 'manager-id') return { then: (cb) => cb(mockManager) };
                if (id === 'emp-id') return { then: (cb) => cb(mockEmp) };
                return { then: (cb) => cb(null) };
            });

            const res = await request(app)
                .post('/api/mobile/executor/employees/emp-id/reset-password')
                .send({ newPassword: 'securePassword123' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.message).toBe('تم إعادة تعيين كلمة المرور بنجاح');
            
            // Password or hash never returned
            expect(res.body.newPassword).toBeUndefined();
            expect(res.body.webPassword).toBeUndefined();

            // Logs check
            expect(mockLogAction).toHaveBeenCalledWith(
                expect.objectContaining({
                    action: 'USER_PASSWORD_CHANGED',
                    metadata: expect.not.objectContaining({ webPassword: expect.any(String) })
                })
            );
        });
    });

    describe('⚠️ Client Complaint Ownership & State Validation', () => {
        test('Complaint on transaction belonging to another user throws 403 Forbidden', async () => {
            testUserPayload = { userId: 'my-user-id', accountType: 'client_user' };
            
            // Mock User lookup
            User.findById.mockResolvedValue({ _id: 'my-user-id', phone: '0912345678', webUsername: 'me' });

            const mockTx = {
                _id: '60d5ec49f83ed82a7c4f4e22',
                userId: 'other-user-phone', // owned by someone else
                status: 'completed',
                save: jest.fn().mockResolvedValue(true)
            };
            Transaction.findById.mockResolvedValue(mockTx);

            const res = await request(app)
                .post('/api/mobile/client/complaints')
                .send({ transactionId: '60d5ec49f83ed82a7c4f4e22', complaintText: 'هذه عملية ليست لي' });

            expect(res.status).toBe(403);
            expect(res.body.code).toBe('FORBIDDEN');
        });

        test('Complaint on cancelled or rejected transaction throws 400 Invalid State', async () => {
            testUserPayload = { userId: 'my-user-id', accountType: 'client_user' };
            User.findById.mockResolvedValue({ _id: 'my-user-id', phone: '0912345678', webUsername: 'me' });

            const mockTx = {
                _id: '60d5ec49f83ed82a7c4f4e23',
                userId: '0912345678',
                status: 'rejected', // Rejected status
                save: jest.fn().mockResolvedValue(true)
            };
            Transaction.findById.mockResolvedValue(mockTx);

            const res = await request(app)
                .post('/api/mobile/client/complaints')
                .send({ transactionId: '60d5ec49f83ed82a7c4f4e23', complaintText: 'الشكوى على عملية مرفوضة' });

            expect(res.status).toBe(400);
            expect(res.body.code).toBe('INVALID_STATE');
        });
    });

    describe('Executor mobile bridge hardening', () => {
        const idempotencyKey = '550e8400-e29b-41d4-a716-446655440000';

        test('ZaynPay execution rejects tasks outside executor group before calling provider', async () => {
            testUserPayload = { userId: 'zayn-id', accountType: 'executor' };
            const emp = {
                _id: 'zayn-id',
                name: 'Zayn API',
                webUsername: 'zaynapi@ahram.com',
                status: 'active',
                groupId: { _id: 'group-a', balance: 1000 }
            };
            Employee.findById.mockReturnValue({ populate: jest.fn().mockResolvedValue(emp) });
            Transaction.findOne.mockResolvedValue(null);
            Transaction.findById.mockResolvedValue({
                _id: 'task-id',
                status: 'accepted',
                operatorId: 'zayn-id',
                executorGroupId: 'group-b',
                amount: 100,
                vodafoneNumber: '01012345678'
            });

            const res = await request(app)
                .post('/api/mobile/executor/tasks/task-id/zaynpay-execute')
                .set('Idempotency-Key', idempotencyKey)
                .send({});

            expect(res.status).toBe(403);
            expect(res.body.code).toBe('FORBIDDEN');
            expect(mockZaynPayInquiry).not.toHaveBeenCalled();
            expect(mockZaynPayPay).not.toHaveBeenCalled();
        });

        test('ZaynPay execution rejects unaccepted or unassigned task before provider call', async () => {
            testUserPayload = { userId: 'zayn-id', accountType: 'executor' };
            const emp = {
                _id: 'zayn-id',
                name: 'Zayn API',
                webUsername: 'zaynapi@ahram.com',
                status: 'active',
                groupId: { _id: 'group-a', balance: 1000 }
            };
            Employee.findById.mockReturnValue({ populate: jest.fn().mockResolvedValue(emp) });
            Transaction.findOne.mockResolvedValue(null);
            Transaction.findById.mockResolvedValue({
                _id: 'task-id',
                status: 'processing',
                operatorId: null,
                executorGroupId: 'group-a',
                amount: 100,
                vodafoneNumber: '01012345678'
            });

            const res = await request(app)
                .post('/api/mobile/executor/tasks/task-id/zaynpay-execute')
                .set('Idempotency-Key', idempotencyKey)
                .send({});

            expect(res.status).toBe(400);
            expect(res.body.code).toBe('INVALID_STATE');
            expect(mockZaynPayInquiry).not.toHaveBeenCalled();
            expect(mockZaynPayPay).not.toHaveBeenCalled();
        });

        test('edit amount updates both sub-account and master balances for sub-client transactions', async () => {
            testUserPayload = { userId: 'operator-id', accountType: 'executor' };
            const tx = {
                _id: 'task-id',
                status: 'accepted',
                operatorId: 'operator-id',
                amount: 100,
                costLYD: 10,
                subAccountCostLYD: 12.5,
                exchangeRate: 10,
                subClientRate: 8,
                isSubAccountTx: true,
                subAccountId: 'sub-id',
                notes: '',
                save: jest.fn().mockResolvedValue(true)
            };
            const subAccount = {
                _id: 'sub-id',
                masterType: 'user',
                masterId: 'master-id',
                balance: 100,
                creditLimit: 20
            };
            const master = {
                _id: 'master-id',
                balance: 100,
                creditLimit: 20
            };

            Employee.findById.mockResolvedValue({ _id: 'operator-id', name: 'Operator' });
            Transaction.findOne
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(null)
                .mockResolvedValueOnce(tx);
            SubAccount.findById.mockReturnValue({ session: jest.fn().mockResolvedValue(subAccount) });
            SubAccount.findOneAndUpdate.mockResolvedValue({ ...subAccount, balance: 87.5 });
            User.findById.mockReturnValue({ session: jest.fn().mockResolvedValue(master) });
            User.findOneAndUpdate.mockResolvedValue({ ...master, balance: 90 });

            const res = await request(app)
                .post('/api/mobile/executor/tasks/task-id/edit-amount')
                .set('Idempotency-Key', idempotencyKey)
                .send({ newAmount: 200, reason: 'تصحيح مبلغ العملية' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(tx.costLYD).toBe(20);
            expect(tx.subAccountCostLYD).toBe(25);
            expect(tx.commission).toBe(5);
            expect(SubAccount.findOneAndUpdate).toHaveBeenCalledWith(
                expect.objectContaining({ _id: 'sub-id', balance: expect.any(Object) }),
                { $inc: { balance: -12.5 } },
                expect.objectContaining({ new: true })
            );
            expect(User.findOneAndUpdate).toHaveBeenCalledWith(
                expect.objectContaining({ _id: 'master-id', balance: expect.any(Object) }),
                { $inc: { balance: -10 } },
                expect.objectContaining({ new: true })
            );
        });

        test('executor support messages reject invalid image payloads', async () => {
            testUserPayload = { userId: 'operator-id', accountType: 'executor' };

            const res = await request(app)
                .post('/api/mobile/executor/tickets/messages')
                .send({ imageBase64: 'data:text/plain;base64,AAAA' });

            expect(res.status).toBe(400);
            expect(res.body.code).toBe('VALIDATION_ERROR');
            expect(SupportTicket.findOne).not.toHaveBeenCalled();
        });

        test('executor support messages accept text without transfer validation side effects', async () => {
            testUserPayload = { userId: 'operator-id', accountType: 'executor' };
            const ticket = {
                _id: 'ticket-id',
                entityType: 'executor',
                entityId: 'operator-id',
                status: 'open',
                messages: [],
                unreadAdmin: 0,
                save: jest.fn().mockResolvedValue(true)
            };
            Employee.findById.mockResolvedValue({
                _id: 'operator-id',
                name: 'Operator',
                phone: '01000000003'
            });
            SupportTicket.findOne.mockResolvedValue(ticket);

            const res = await request(app)
                .post('/api/mobile/executor/tickets/messages')
                .send({ text: 'أحتاج مراجعة عملية معلقة' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.message.text).toBe('أحتاج مراجعة عملية معلقة');
            expect(ticket.messages).toHaveLength(1);
            expect(ticket.save).toHaveBeenCalled();
        });
    });

    describe('📊 Reports parity rules', () => {
        test('Company employee report enforces today-only when canViewAllReports is false', async () => {
            testUserPayload = { userId: 'emp-id', accountType: 'client_company' };

            const mockEmp = { _id: 'emp-id', name: 'Employee User', companyId: 'company-id-123', canViewAllReports: false };
            ClientEmployee.findById.mockResolvedValue(mockEmp);
            
            const mockCompany = { _id: 'company-id-123', name: 'Ahram Company' };
            ClientCompany.findById.mockResolvedValue(mockCompany);

            const res = await request(app)
                .post('/api/mobile/client/reports/filter')
                .send({ dateType: 'month', dateValue: '2026-05' });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.data.entityInfo.status).toContain('موظف شركة');
        });
    });
});
