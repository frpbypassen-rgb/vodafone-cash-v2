// tests/wallet.test.js
const { updateBalanceWithLedger } = require('../services/walletService');
const mongoose = require('mongoose');

// 1. محاكاة قاعدة بيانات MongoDB والجلسات الذرية
jest.mock('mongoose', () => {
    const mockSession = {
        startTransaction: jest.fn(),
        commitTransaction: jest.fn(),
        endSession: jest.fn(),
        abortTransaction: jest.fn()
    };
    const mockAccount = {
        _id: '12345',
        balance: 1000,
        save: jest.fn().mockResolvedValue(true)
    };
    return {
        startSession: jest.fn().mockResolvedValue(mockSession),
        model: jest.fn().mockReturnValue({
            findById: jest.fn().mockReturnValue({
                session: jest.fn().mockResolvedValue(mockAccount)
            })
        }),
        // تصدير المحاكاة لكي نختبرها
        _mockSession: mockSession,
        _mockAccount: mockAccount
    };
});

// 2. محاكاة نموذج دفتر الأستاذ (Ledger) كـ Class حقيقي لتفادي خطأ الـ Prototype
jest.mock('../models/Ledger', () => {
    return class LedgerMock {
        constructor(data) {
            Object.assign(this, data);
        }
        save() {
            return Promise.resolve(this);
        }
        static create() {
            return Promise.resolve(true);
        }
    };
});

describe('Financial Engine (Double Entry Ledger) Tests', () => {
    
    beforeEach(() => {
        jest.clearAllMocks();
        // إعادة الرصيد إلى 1000 قبل كل اختبار لضمان استقلالية الاختبارات
        mongoose._mockAccount.balance = 1000;
    });

    test('يجب أن يقوم بإضافة الرصيد بشكل صحيح (Deposit)', async () => {
        const result = await updateBalanceWithLedger('User', '12345', 500, 'DEPOSIT', 'TX-001', 'إيداع تجريبي');
        
        expect(result.success).toBe(true);
        expect(result.balanceAfter).toBe(1500); // 1000 + 500
        expect(mongoose._mockAccount.save).toHaveBeenCalled();
        expect(mongoose._mockSession.commitTransaction).toHaveBeenCalled();
    });

    test('يجب أن يقوم بخصم الرصيد بشكل صحيح (Deduction)', async () => {
        const result = await updateBalanceWithLedger('User', '12345', -200, 'DEDUCTION', 'TX-002', 'خصم تجريبي');
        
        expect(result.success).toBe(true);
        expect(result.balanceAfter).toBe(800); // 1000 - 200
        expect(mongoose._mockAccount.save).toHaveBeenCalled();
    });

    test('يجب أن يلغي العملية (Rollback) إذا حدث خطأ أثناء الحفظ', async () => {
        // إجبار السيرفر الوهمي على الانهيار لاختبار الأمان
        mongoose._mockAccount.save.mockRejectedValueOnce(new Error('Database Crash'));

        await expect(
            updateBalanceWithLedger('User', '12345', 100, 'DEPOSIT', 'TX-003', 'إيداع سيفشل')
        ).rejects.toThrow('Database Crash');

        // التأكد من أن النظام قام بالتراجع فوراً لحماية الرصيد
        expect(mongoose._mockSession.abortTransaction).toHaveBeenCalled(); 
    });
});