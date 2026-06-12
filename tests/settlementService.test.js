// tests/settlementService.test.js
'use strict';

const mongoose = require('mongoose');

// محاكاة النماذج لـ settlementService
jest.mock('../models/Settlement');
jest.mock('../models/Transaction');
jest.mock('../models/Ledger');
jest.mock('../models/User');
jest.mock('../models/ClientBot');
jest.mock('../models/ExecutorGroup');
jest.mock('../utils/logger', () => ({
    financial: jest.fn(),
    error: jest.fn()
}));

const Settlement = require('../models/Settlement');
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const logger = require('../utils/logger');

const {
    generateDailySettlement,
    generateExecutorSettlement,
    approveSettlement,
    getSettlements
} = require('../services/settlementService');

describe('Settlement Service Tests', () => {

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('generateDailySettlement', () => {
        test('يجب إرجاع التسوية الحالية إذا كانت منشأة مسبقاً لنفس اليوم', async () => {
            const mockExisting = { _id: 'settlement-123', status: 'draft' };
            Settlement.findOne = jest.fn().mockResolvedValue(mockExisting);

            const result = await generateDailySettlement();

            expect(result).toEqual(mockExisting);
            expect(Settlement.findOne).toHaveBeenCalled();
            // لا يجب استدعاء Transaction.find لأننا لم نقم بإنشاء تسوية جديدة
            expect(Transaction.find).not.toHaveBeenCalled();
        });

        test('يجب توليد تسوية يومية جديدة وحساب الإجماليات بشكل صحيح', async () => {
            // لا توجد تسوية مسبقة
            Settlement.findOne = jest.fn().mockResolvedValue(null);

            // إعداد معاملات وهمية للتسوية
            const mockTransactions = [
                { status: 'completed', transferType: 'vodafone', amount: 100, costLYD: 640 },
                { status: 'completed', transferType: 'vodafone', amount: 200, costLYD: 1280 },
                { status: 'rejected', transferType: 'post_account', amount: 150, costLYD: 960 }, // ملغاة
                { status: 'pending', transferType: 'post_card', amount: 50, costLYD: 320 } // معلقة
            ];

            Transaction.find = jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue(mockTransactions)
            });

            // محاكاة حفظ التسوية
            const saveMock = jest.fn().mockResolvedValue({});
            Settlement.mockImplementation(function (data) {
                Object.assign(this, data);
                this.save = saveMock;
                return this;
            });

            const result = await generateDailySettlement(new Date('2026-06-08'));

            expect(result).toBeDefined();
            expect(result.status).toBe('draft');
            expect(result.summary.totalTransactions).toBe(4);
            expect(result.summary.totalAmountEGP).toBe(500); // 100 + 200 + 150 + 50
            expect(result.summary.totalCostLYD).toBe(3200); // 640 + 1280 + 960 + 320
            expect(result.summary.totalRefunds).toBe(960); // للعمليات الملغاة (status: rejected)
            expect(result.summary.netAmount).toBe(2240); // totalCostLYD - totalRefunds = 3200 - 960
            expect(result.summary.completedCount).toBe(2);
            expect(result.summary.cancelledCount).toBe(1);
            expect(result.summary.pendingCount).toBe(1);

            // التحقق من التجميع بحسب النوع
            expect(result.details.transferTypes.vodafone).toEqual({ count: 2, amount: 300 });
            expect(result.details.transferTypes.post_account).toEqual({ count: 1, amount: 150 });

            expect(saveMock).toHaveBeenCalled();
            expect(logger.financial).toHaveBeenCalled();
        });

        test('يجب تسجيل الخطأ عند الفشل في حفظ التسوية اليومية', async () => {
            Settlement.findOne = jest.fn().mockReturnValue(Promise.resolve(null));
            Transaction.find = jest.fn().mockReturnValue({
                lean: jest.fn().mockRejectedValue(new Error('Database Failure'))
            });

            await expect(generateDailySettlement()).rejects.toThrow('Database Failure');
            expect(logger.error).toHaveBeenCalled();
        });
    });

    describe('generateExecutorSettlement', () => {
        test('يجب رمي خطأ EXECUTOR_NOT_FOUND إذا لم يتم العثور على المنفذ', async () => {
            ExecutorGroup.findById = jest.fn().mockResolvedValue(null);

            await expect(generateExecutorSettlement('exec-invalid', new Date(), new Date()))
                .rejects.toThrow('EXECUTOR_NOT_FOUND');
        });

        test('يجب إنشاء تسوية مخصصة للمنفذ وحساب الرصيد الافتتاحي والنهائي', async () => {
            const mockExecutor = { _id: 'exec-123', name: 'Executor A', balance: 5000 };
            ExecutorGroup.findById = jest.fn().mockResolvedValue(mockExecutor);

            const mockTransactions = [
                { status: 'completed', amount: 1000 },
                { status: 'completed', amount: 2000 }
            ];

            Transaction.find = jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue(mockTransactions)
            });

            const saveMock = jest.fn().mockResolvedValue({});
            Settlement.mockImplementation(function (data) {
                Object.assign(this, data);
                this.save = saveMock;
                return this;
            });

            const result = await generateExecutorSettlement('exec-123', new Date(), new Date());

            expect(result.entityType).toBe('executor');
            expect(result.entityId).toBe('exec-123');
            expect(result.summary.totalTransactions).toBe(2);
            expect(result.summary.totalAmountEGP).toBe(3000);
            expect(result.details.openingBalance).toBe(8000); // balance + totalAmountEGP = 5000 + 3000
            expect(result.details.closingBalance).toBe(5000); // balance

            expect(saveMock).toHaveBeenCalled();
        });

        test('يجب تسجيل الخطأ عند حدوث خطأ استثنائي أثناء تسوية المنفذ', async () => {
            ExecutorGroup.findById = jest.fn().mockRejectedValue(new Error('Connection Lost'));

            await expect(generateExecutorSettlement('exec-123', new Date(), new Date()))
                .rejects.toThrow('Connection Lost');
            expect(logger.error).toHaveBeenCalled();
        });
    });

    describe('approveSettlement', () => {
        test('يجب تحديث حالة التسوية إلى معتمدة بنجاح', async () => {
            const mockUpdated = { _id: 'settlement-123', status: 'approved' };
            Settlement.findByIdAndUpdate = jest.fn().mockResolvedValue(mockUpdated);

            const result = await approveSettlement('settlement-123', 'admin-id', 'Admin Mohamed');

            expect(result).toEqual(mockUpdated);
            expect(Settlement.findByIdAndUpdate).toHaveBeenCalledWith(
                'settlement-123',
                expect.objectContaining({
                    $set: expect.objectContaining({
                        status: 'approved',
                        approvedBy: 'admin-id',
                        approvedByName: 'Admin Mohamed'
                    })
                }),
                { new: true }
            );
        });
    });

    describe('getSettlements', () => {
        test('يجب جلب قائمة التسويات مع الفلاتر وخيارات الصفحات', async () => {
            const mockSettlements = [{ type: 'daily' }];
            Settlement.find = jest.fn().mockReturnValue({
                sort: jest.fn().mockReturnValue({
                    skip: jest.fn().mockReturnValue({
                        limit: jest.fn().mockReturnValue({
                            lean: jest.fn().mockResolvedValue(mockSettlements)
                        })
                    })
                })
            });

            const result = await getSettlements({ type: 'daily' }, { limit: 10, skip: 5 });

            expect(result).toEqual(mockSettlements);
            expect(Settlement.find).toHaveBeenCalledWith({ type: 'daily' });
        });
    });
});
