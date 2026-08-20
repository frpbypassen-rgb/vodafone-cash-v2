// tests/walletService.test.js
'use strict';

// محاكاة نموذج دفتر الأستاذ
jest.mock('../models/Ledger', () => {
    return class LedgerMock {
        constructor(data) { Object.assign(this, data); }
        save() { return Promise.resolve(this); }
        static create() { return Promise.resolve(true); }
    };
});

const { updateBalanceWithLedger, requiresMongoTransactions } = require('../services/walletService');
const mongoose = require('mongoose');

describe('Wallet Service Deep Tests', () => {
    let mockSession;
    let mockModel;
    const originalNodeEnv = process.env.NODE_ENV;
    const originalTransactionRequirement = process.env.MONGO_TRANSACTIONS_REQUIRED;
    const originalEmergencyFallback = process.env.EMERGENCY_STANDALONE_FINANCIAL_WRITES;
    const originalEmergencyFallbackExpiry = process.env.EMERGENCY_STANDALONE_FINANCIAL_WRITES_EXPIRES_AT;

    beforeEach(() => {
        jest.clearAllMocks();

        mockSession = {
            startTransaction: jest.fn(),
            commitTransaction: jest.fn().mockResolvedValue(undefined),
            abortTransaction: jest.fn().mockResolvedValue(undefined),
            endSession: jest.fn()
        };

        mockModel = {
            modelName: 'User',
            findOneAndUpdate: jest.fn()
        };

        // إرجاع النموذج الوهمي عند استدعاء mongoose.model
        mongoose.model = jest.fn().mockReturnValue(mockModel);
        mongoose.startSession = jest.fn().mockResolvedValue(mockSession);
        process.env.NODE_ENV = 'test';
        process.env.MONGO_TRANSACTIONS_REQUIRED = 'false';
        delete process.env.EMERGENCY_STANDALONE_FINANCIAL_WRITES;
        delete process.env.EMERGENCY_STANDALONE_FINANCIAL_WRITES_EXPIRES_AT;
    });

    afterAll(() => {
        process.env.NODE_ENV = originalNodeEnv;
        if (originalTransactionRequirement === undefined) delete process.env.MONGO_TRANSACTIONS_REQUIRED;
        else process.env.MONGO_TRANSACTIONS_REQUIRED = originalTransactionRequirement;
        if (originalEmergencyFallback === undefined) delete process.env.EMERGENCY_STANDALONE_FINANCIAL_WRITES;
        else process.env.EMERGENCY_STANDALONE_FINANCIAL_WRITES = originalEmergencyFallback;
        if (originalEmergencyFallbackExpiry === undefined) delete process.env.EMERGENCY_STANDALONE_FINANCIAL_WRITES_EXPIRES_AT;
        else process.env.EMERGENCY_STANDALONE_FINANCIAL_WRITES_EXPIRES_AT = originalEmergencyFallbackExpiry;
    });

    test('يجب أن يعمل بشكل طبيعي إذا كان السيرفر يدعم الجلسات', async () => {
        mockModel.findOneAndUpdate.mockResolvedValue({
            _id: 'user1',
            balance: 800
        });

        const result = await updateBalanceWithLedger('User', 'user1', -200, 'TRANSFER', 'TX-001', 'تحويل', { minBalance: 100 });

        expect(result.success).toBe(true);
        expect(result.balanceAfter).toBe(800);
        expect(mockSession.commitTransaction).toHaveBeenCalled();
        expect(mockSession.endSession).toHaveBeenCalled();
    });

    test('يجب تفعيل وضع البديل (executeFallback) إذا لم يكن السيرفر جزءاً من Replica Set ويرمي خطأ معاملة', async () => {
        // رمي خطأ يفيد بعدم دعم الـ Transactions
        mongoose.startSession.mockRejectedValue(new Error('This MongoDB deployment does not support replica set transactions'));
        
        mockModel.findOneAndUpdate.mockResolvedValue({
            _id: 'user1',
            balance: 800
        });

        const result = await updateBalanceWithLedger('User', 'user1', -200, 'TRANSFER', 'TX-001', 'تحويل', { minBalance: 100 });

        expect(result.success).toBe(true);
        expect(result.balanceAfter).toBe(800);
        // التحقق من أن findOneAndUpdate استدعيت في وضع executeFallback بدون session
        expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
            expect.any(Object),
            expect.any(Object),
            { new: true } // بدون session
        );
    });

    test('يجب استرجاع الخطأ الأصلي إذا رمى خطأ قاعدة بيانات عام لا علاقة له بالـ Replica Set', async () => {
        mongoose.startSession.mockRejectedValue(new Error('Connection timeout'));

        await expect(
            updateBalanceWithLedger('User', 'user1', -200, 'TRANSFER', 'TX-001', 'تحويل')
        ).rejects.toThrow('Connection timeout');
    });

    test('يجب أن يفشل مغلقاً في الإنتاج قبل تعديل الرصيد عند غياب Mongo Transactions', async () => {
        process.env.NODE_ENV = 'production';
        process.env.MONGO_TRANSACTIONS_REQUIRED = 'true';
        mongoose.startSession.mockRejectedValue(
            new Error('This MongoDB deployment does not support replica set transactions')
        );

        await expect(
            updateBalanceWithLedger('User', 'user1', 200, 'DEPOSIT', 'TX-PROD', 'إيداع إنتاج')
        ).rejects.toMatchObject({
            code: 'FINANCIAL_TRANSACTIONS_UNAVAILABLE',
            statusCode: 503
        });
        expect(mockModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('يسمح بالمسار المحمي مؤقتاً أثناء حادث MongoDB في الإنتاج', async () => {
        process.env.NODE_ENV = 'production';
        process.env.MONGO_TRANSACTIONS_REQUIRED = 'true';
        process.env.EMERGENCY_STANDALONE_FINANCIAL_WRITES = 'true';
        process.env.EMERGENCY_STANDALONE_FINANCIAL_WRITES_EXPIRES_AT = new Date(Date.now() + 60_000).toISOString();
        mongoose.startSession.mockRejectedValue(new Error('This MongoDB deployment does not support replica set transactions'));
        mockModel.findOneAndUpdate.mockResolvedValue({ _id: 'user1', balance: 800 });

        expect(requiresMongoTransactions()).toBe(false);
        await expect(
            updateBalanceWithLedger('User', 'user1', -200, 'TRANSFER', 'TX-EMERGENCY', 'تحويل طوارئ')
        ).resolves.toMatchObject({ success: true, balanceAfter: 800 });
    });

    test('يجب دعم تمرير جلسة (Session) خارجية مباشرة واستخدامها', async () => {
        mockModel.findOneAndUpdate.mockResolvedValue({
            _id: 'user1',
            balance: 1200
        });

        const externalSession = { id: 'ext-session-123' };

        const result = await updateBalanceWithLedger('User', 'user1', 200, 'DEPOSIT', 'TX-002', 'شحن خارجي', {
            session: externalSession
        });

        expect(result.success).toBe(true);
        expect(result.balanceAfter).toBe(1200);
        expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
            { _id: 'user1' },
            { $inc: { balance: 200 } },
            { new: true, session: externalSession }
        );
        // لا يجب إنهاء الجلسة الخارجية برمجياً داخل الخدمة
        expect(mongoose.startSession).not.toHaveBeenCalled();
    });

    test('يجب رمي خطأ INSUFFICIENT_BALANCE إذا لم يعثر على الحساب للخصم في وضع الجلسة', async () => {
        mockModel.findOneAndUpdate.mockResolvedValue(null); // يمثل رصيد غير كاف أو حساب غير موجود

        await expect(
            updateBalanceWithLedger('User', 'user1', -200, 'TRANSFER', 'TX-001', 'خصم سيفشل')
        ).rejects.toThrow('INSUFFICIENT_BALANCE');
    });

    test('يجب رمي خطأ ACCOUNT_NOT_FOUND إذا لم يعثر على الحساب للإيداع في وضع الجلسة', async () => {
        mockModel.findOneAndUpdate.mockResolvedValue(null);

        await expect(
            updateBalanceWithLedger('User', 'user1', 200, 'DEPOSIT', 'TX-001', 'إيداع سيفشل')
        ).rejects.toThrow('ACCOUNT_NOT_FOUND');
    });

    test('يجب رمي خطأ INSUFFICIENT_BALANCE إذا لم يعثر على الحساب للخصم في وضع البديل/الـ Fallback', async () => {
        mongoose.startSession.mockRejectedValue(new Error('replica set transactions not supported'));
        mockModel.findOneAndUpdate.mockResolvedValue(null);

        await expect(
            updateBalanceWithLedger('User', 'user1', -200, 'TRANSFER', 'TX-001', 'خصم سيفشل في البديل')
        ).rejects.toThrow('INSUFFICIENT_BALANCE');
    });

    test('يسمح للتسوية الإدارية بتجاوز الصفر عند تفعيل allowNegative', async () => {
        mockModel.findOneAndUpdate.mockResolvedValue({
            _id: 'user1',
            balance: -50
        });

        const result = await updateBalanceWithLedger(
            'User',
            'user1',
            -150,
            'DEDUCTION',
            'DED-NEGATIVE',
            'خصم إداري يسمح بالرصيد السالب',
            { allowNegative: true }
        );

        expect(result.balanceBefore).toBe(100);
        expect(result.balanceAfter).toBe(-50);
        expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
            { _id: 'user1' },
            { $inc: { balance: -150 } },
            { new: true, session: mockSession }
        );
    });
});

