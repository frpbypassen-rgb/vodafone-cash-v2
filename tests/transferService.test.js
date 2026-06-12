// tests/transferService.test.js
'use strict';

// محاكاة النماذج اللازمة لـ transferService
jest.mock('../models/User');
jest.mock('../models/ClientEmployee');
jest.mock('../models/ClientCompany');
jest.mock('../models/Employee');
jest.mock('../models/Transaction');
jest.mock('../models/Ledger');
jest.mock('../models/JournalEvent');
jest.mock('../models/Counter');
jest.mock('../models/Settings');
jest.mock('../services/auditService');
jest.mock('../services/lockService', () => ({
    acquireLock: jest.fn().mockResolvedValue({ release: jest.fn().mockResolvedValue(undefined) }),
    releaseLock: jest.fn().mockResolvedValue(undefined)
}));

const { createTransfer, cancelTransfer } = require('../services/transferService');
const mongoose = require('mongoose');
const crypto = require('crypto');

const User = require('../models/User');
const ClientEmployee = require('../models/ClientEmployee');
const ClientCompany = require('../models/ClientCompany');
const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const Ledger = require('../models/Ledger');
const JournalEvent = require('../models/JournalEvent');
const Counter = require('../models/Counter');
const Settings = require('../models/Settings');
const auditService = require('../services/auditService');

// Helper to build fingerprint for test matching
const buildTestFingerprint = ({ userId, accountType, transferData }) => {
    const payload = {
        userId: String(userId),
        accountType,
        transferType: transferData.transferType || null,
        amount: Number(transferData.amount),
        number: transferData.number || null,
        name: transferData.name || null,
        notes: transferData.notes || null
    };
    return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
};

describe('Transfer Service Deep Tests', () => {
    let mockSession;

    beforeEach(() => {
        jest.clearAllMocks();

        mockSession = {
            startTransaction: jest.fn(),
            commitTransaction: jest.fn().mockResolvedValue(undefined),
            abortTransaction: jest.fn().mockResolvedValue(undefined),
            endSession: jest.fn()
        };

        mongoose.startSession = jest.fn().mockResolvedValue(mockSession);

        JournalEvent.findOne = jest.fn().mockImplementation(() => {
            const query = {
                sort: jest.fn().mockImplementation(() => {
                    const subQuery = {
                        session: jest.fn().mockResolvedValue(null)
                    };
                    return subQuery;
                })
            };
            return query;
        });
    });

    describe('createTransfer tests', () => {
        test('يجب رفض إنشاء تحويل إذا كان الحساب من نوع executor', async () => {
            const result = await createTransfer({
                userId: 'exec-123',
                accountType: 'executor',
                transferData: {}
            });
            expect(result.success).toBe(false);
            expect(result.statusCode).toBe(403);
            expect(result.code).toBe('FORBIDDEN');
        });

        test('يجب إعادة نفس النتيجة السابقة إذا تكرر الطلب بنفس مفتاح منع التكرار وبصمة مطابقة (Idempotency Replay)', async () => {
            const userId = 'user-123';
            const accountType = 'client_user';
            const transferData = {
                transferType: 'vodafone',
                amount: 100,
                number: '01012345678',
                name: 'محمد',
                notes: 'تجربة'
            };

            const fingerprint = buildTestFingerprint({ userId, accountType, transferData });

            const mockTx = {
                customId: 'ATT-2601-0001',
                idempotencyKey: 'idemp-key-1',
                idempotencyFingerprint: fingerprint, // البصمة المطابقة
                status: 'pending',
                costLYD: 500,
                exchangeRate: 6.40,
                idempotencyResponse: {
                    success: true,
                    txId: 'ATT-2601-0001',
                    newBalance: 4500
                }
            };

            Transaction.findOne = jest.fn().mockReturnValue({
                session: jest.fn().mockResolvedValue(mockTx)
            });

            const req = {
                headers: { 'idempotency-key': 'idemp-key-1' }
            };

            const result = await createTransfer({
                userId,
                accountType,
                transferData,
                req
            });

            expect(result.success).toBe(true);
            expect(result.code).toBe('DUPLICATE_REPLAYED');
            expect(result.txId).toBe('ATT-2601-0001');
        });

        test('يجب إرجاع خطأ IDEMPOTENCY_CONFLICT إذا تطابق المفتاح مع بصمة مختلفة للطلب', async () => {
            const mockTx = {
                customId: 'ATT-2601-0001',
                idempotencyKey: 'idemp-key-1',
                idempotencyFingerprint: 'different-fingerprint'
            };

            Transaction.findOne = jest.fn().mockReturnValue({
                session: jest.fn().mockResolvedValue(mockTx)
            });

            const req = {
                headers: { 'idempotency-key': 'idemp-key-1' }
            };

            const result = await createTransfer({
                userId: 'user-123',
                accountType: 'client_user',
                transferData: {
                    transferType: 'vodafone',
                    amount: 100,
                    number: '01012345678',
                    name: 'محمد',
                    notes: 'تجربة'
                },
                req
            });

            expect(result.success).toBe(false);
            expect(result.statusCode).toBe(409);
            expect(result.code).toBe('IDEMPOTENCY_CONFLICT');
        });

        test('يجب إنشاء التحويل وخصم الرصيد بنجاح للمستخدم الفردي', async () => {
            const mockSettings = {
                rateLevel1: 6.40,
                rateLevel2: 6.45,
                rateLevel3: 6.50,
                isManualClosed: false
            };
            const mockUser = {
                _id: 'user-123',
                name: 'أحمد محمد',
                phone: '01012345678',
                tier: 2,
                creditLimit: 1000,
                balance: 5000
            };

            // No idempotency conflicts
            Transaction.findOne = jest.fn().mockReturnValue({
                session: jest.fn().mockResolvedValue(null)
            });

            Settings.findOne = jest.fn().mockImplementation(() => {
                const promise = Promise.resolve(mockSettings);
                promise.session = jest.fn().mockReturnValue(promise);
                return promise;
            });

            User.findById = jest.fn().mockImplementation(() => {
                const promise = Promise.resolve(mockUser);
                promise.session = jest.fn().mockReturnValue(promise);
                return promise;
            });

            User.findOneAndUpdate = jest.fn().mockResolvedValue({
                _id: 'user-123',
                balance: 4500,
                balances: { EGP: 4500, LYD: 4500 }
            });

            Counter.findOneAndUpdate = jest.fn().mockResolvedValue({ value: 123 });

            Transaction.prototype.save = jest.fn().mockResolvedValue(true);
            Ledger.prototype.save = jest.fn().mockResolvedValue(true);

            const req = {
                headers: { 'idempotency-key': 'idemp-key-new' }
            };

            const result = await createTransfer({
                userId: 'user-123',
                accountType: 'client_user',
                transferData: {
                    transferType: 'vodafone',
                    amount: 100,
                    number: '01012345678',
                    name: 'محمد',
                    notes: 'تحويل ناجح'
                },
                req
            });

            expect(result.success).toBe(true);
            expect(result.statusCode).toBe(200);
            expect(result.code).toBe('SUCCESS');
            expect(result.txId).toContain('ATT-');
            expect(mockSession.commitTransaction).toHaveBeenCalled();
        });

        test('يجب إنشاء التحويل وخصم الرصيد بنجاح لموظف شركة', async () => {
            const mockSettings = {
                rateLevel1: 6.40,
                rateLevel2: 6.45,
                rateLevel3: 6.50,
                isManualClosed: false
            };
            const mockEmployee = {
                _id: 'emp-123',
                name: 'موظف شركة A',
                companyId: 'company-123'
            };
            const mockCompany = {
                _id: 'company-123',
                name: 'شركة A',
                tier: 1,
                creditLimit: 2000,
                balance: 10000
            };

            Transaction.findOne = jest.fn().mockReturnValue({
                session: jest.fn().mockResolvedValue(null)
            });

            Settings.findOne = jest.fn().mockImplementation(() => {
                const promise = Promise.resolve(mockSettings);
                promise.session = jest.fn().mockReturnValue(promise);
                return promise;
            });

            ClientEmployee.findById = jest.fn().mockImplementation(() => {
                const promise = Promise.resolve(mockEmployee);
                promise.session = jest.fn().mockReturnValue(promise);
                return promise;
            });

            ClientCompany.findById = jest.fn().mockImplementation(() => {
                const promise = Promise.resolve(mockCompany);
                promise.session = jest.fn().mockReturnValue(promise);
                return promise;
            });

            ClientCompany.findOneAndUpdate = jest.fn().mockResolvedValue({
                _id: 'company-123',
                balance: 9500,
                balances: { EGP: 9500, LYD: 9500 }
            });

            Counter.findOneAndUpdate = jest.fn().mockResolvedValue({ value: 124 });

            Transaction.prototype.save = jest.fn().mockResolvedValue(true);
            Ledger.prototype.save = jest.fn().mockResolvedValue(true);

            const req = {
                headers: { 'idempotency-key': 'idemp-key-company' }
            };

            const result = await createTransfer({
                userId: 'emp-123',
                accountType: 'client_company',
                transferData: {
                    transferType: 'post_account', // لتغطية شرط تعديل السعر للبريد
                    amount: 100,
                    number: '01012345678',
                    name: 'شركة فرعية',
                    notes: 'تحويل شركة'
                },
                req
            });

            expect(result.success).toBe(true);
            expect(result.statusCode).toBe(200);
            expect(result.code).toBe('SUCCESS');
            expect(mockSession.commitTransaction).toHaveBeenCalled();
        });
    });

    describe('cancelTransfer tests', () => {
        test('يجب إلغاء العملية وإرجاع الرصيد بنجاح للشركة', async () => {
            const mockTx = {
                _id: 'tx-123',
                customId: 'ATT-2601-0001',
                status: 'accepted',
                operatorId: 'emp-123',
                companyId: 'company-123',
                costLYD: 500,
                notes: 'طلب أصلي',
                save: jest.fn().mockResolvedValue(true)
            };

            const mockEmp = {
                _id: 'emp-123',
                name: 'موظف التجربة'
            };

            Transaction.findById = jest.fn().mockReturnValue({
                session: jest.fn().mockResolvedValue(mockTx)
            });

            Employee.findOne = jest.fn().mockReturnValue({
                session: jest.fn().mockResolvedValue(mockEmp)
            });

            ClientCompany.findByIdAndUpdate = jest.fn().mockResolvedValue({
                _id: 'company-123',
                balance: 1500,
                balances: { EGP: 1500, LYD: 1500 }
            });

            Ledger.prototype.save = jest.fn().mockResolvedValue(true);

            const result = await cancelTransfer({
                taskId: 'tx-123',
                userId: 'emp-username',
                reason: 'المستلم لم يرد',
                req: {}
            });

            expect(result.success).toBe(true);
            expect(result.statusCode).toBe(200);
            expect(mockTx.status).toBe('rejected');
            expect(ClientCompany.findByIdAndUpdate).toHaveBeenCalledWith(
                'company-123',
                { $inc: { balance: 500 } },
                { new: true, session: mockSession }
            );
            expect(mockSession.commitTransaction).toHaveBeenCalled();
        });

        test('يجب إلغاء العملية وإرجاع الرصيد بنجاح للمستخدم الفردي', async () => {
            const mockTx = {
                _id: 'tx-123',
                customId: 'ATT-2601-0001',
                status: 'accepted',
                operatorId: 'emp-123',
                userId: '01012345678', // رقم هاتف المستخدم الفردي
                costLYD: 500,
                notes: 'طلب أصلي',
                save: jest.fn().mockResolvedValue(true)
            };

            const mockEmp = {
                _id: 'emp-123',
                name: 'موظف التجربة'
            };

            const mockUser = {
                _id: 'user-123',
                balance: 1000,
                balances: { EGP: 1000, LYD: 1000 }
            };

            Transaction.findById = jest.fn().mockReturnValue({
                session: jest.fn().mockResolvedValue(mockTx)
            });

            Employee.findOne = jest.fn().mockReturnValue({
                session: jest.fn().mockResolvedValue(mockEmp)
            });

            // Mock User.findOne to work with thenable chaining (since there is no .session chained in code)
            User.findOne = jest.fn().mockImplementation(() => {
                const promise = Promise.resolve(mockUser);
                promise.session = jest.fn().mockReturnValue(promise);
                return promise;
            });

            User.findByIdAndUpdate = jest.fn().mockResolvedValue({
                _id: 'user-123',
                balance: 1500,
                balances: { EGP: 1500, LYD: 1500 }
            });

            Ledger.prototype.save = jest.fn().mockResolvedValue(true);

            const result = await cancelTransfer({
                taskId: 'tx-123',
                userId: 'emp-username',
                reason: 'إلغاء فوري',
                req: {}
            });

            expect(result.success).toBe(true);
            expect(result.statusCode).toBe(200);
            expect(mockTx.status).toBe('rejected');
            expect(User.findByIdAndUpdate).toHaveBeenCalledWith(
                'user-123',
                { $inc: { balance: 500 } },
                { new: true, session: mockSession }
            );
            expect(mockSession.commitTransaction).toHaveBeenCalled();
        });

        test('يجب رفض الإلغاء إذا لم يعثر على الموظف', async () => {
            Transaction.findById = jest.fn().mockReturnValue({
                session: jest.fn().mockResolvedValue({ status: 'accepted' })
            });
            Employee.findOne = jest.fn().mockReturnValue({
                session: jest.fn().mockResolvedValue(null) // لم يعثر على الموظف
            });

            const result = await cancelTransfer({
                taskId: 'tx-123',
                userId: 'wrong-username',
                reason: 'إلغاء'
            });

            expect(result.success).toBe(false);
            expect(result.statusCode).toBe(500);
            expect(result.code).toBe('SERVER_ERROR');
            expect(mockSession.abortTransaction).toHaveBeenCalled();
        });

        test('يجب رفض الإلغاء إذا كانت حالة العملية غير صالحة أو غير مقبولة من الموظف', async () => {
            const mockTx = {
                status: 'pending', // حالة غير صالحة للإلغاء (يجب أن تكون accepted)
                operatorId: 'emp-abc'
            };
            const mockEmp = { _id: 'emp-123' };

            Transaction.findById = jest.fn().mockReturnValue({
                session: jest.fn().mockResolvedValue(mockTx)
            });
            Employee.findOne = jest.fn().mockReturnValue({
                session: jest.fn().mockResolvedValue(mockEmp)
            });

            const result = await cancelTransfer({
                taskId: 'tx-123',
                userId: 'emp-username',
                reason: 'إلغاء'
            });

            expect(result.success).toBe(false);
            expect(result.statusCode).toBe(500);
            expect(result.code).toBe('INVALID_STATE');
        });
    });
});
