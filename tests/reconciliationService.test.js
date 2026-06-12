// tests/reconciliationService.test.js
'use strict';

const mongoose = require('mongoose');

// محاكاة النماذج لـ reconciliationService
jest.mock('../models/Reconciliation');
jest.mock('../models/Ledger');
jest.mock('../models/Transaction');
jest.mock('../models/User');
jest.mock('../models/ClientBot');
jest.mock('../models/ExecutorGroup');
jest.mock('../utils/logger', () => ({
    financial: jest.fn(),
    error: jest.fn()
}));

const Reconciliation = require('../models/Reconciliation');
const Ledger = require('../models/Ledger');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const ClientBot = require('../models/ClientBot');
const ExecutorGroup = require('../models/ExecutorGroup');
const logger = require('../utils/logger');

const { reconcileDaily, detectDiscrepancies, getReconciliationReports } = require('../services/reconciliationService');

describe('Reconciliation Service Tests', () => {

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('reconcileDaily', () => {
        test('يجب أن تنجح المطابقة بالكامل عندما تتطابق أرصدة جميع الحسابات مع قيود دفتر الأستاذ', async () => {
            // تجهيز البيانات الوهمية
            const mockUsers = [{ _id: new mongoose.Types.ObjectId(), name: 'User 1', balance: 500 }];
            const mockClientBots = [{ _id: new mongoose.Types.ObjectId(), name: 'Company A', balance: 1000 }];
            const mockExecutors = [{ _id: new mongoose.Types.ObjectId(), name: 'Executor Group 1', balance: 1500 }];

            User.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(mockUsers) });
            ClientBot.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(mockClientBots) });
            ExecutorGroup.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(mockExecutors) });

            // محاكاة Ledger.aggregate لإرجاع رصيد مطابق للرصيد الفعلي
            Ledger.aggregate = jest.fn()
                .mockResolvedValueOnce([{ _id: null, totalBalance: 500 }]) // لـ User 1
                .mockResolvedValueOnce([{ _id: null, totalBalance: 1000 }]) // لـ Company A
                .mockResolvedValueOnce([{ _id: null, totalBalance: 1500 }]); // لـ Executor Group 1

            // محاكاة فحوصات السلامة
            Transaction.find = jest.fn().mockReturnValue({
                distinct: jest.fn().mockResolvedValue(['TX-1', 'TX-2'])
            });
            Ledger.distinct = jest.fn().mockResolvedValue(['TX-1', 'TX-2']);

            // محاكاة حفظ التقرير
            const saveMock = jest.fn().mockResolvedValue({});
            Reconciliation.mockImplementation(function (data) {
                Object.assign(this, data);
                this.save = saveMock;
                return this;
            });

            const result = await reconcileDaily();

            expect(result).toBeDefined();
            expect(result.status).toBe('matched');
            expect(result.summary.totalEntitiesChecked).toBe(3);
            expect(result.summary.discrepancyCount).toBe(0);
            expect(result.summary.totalAccountBalance).toBe(3000);
            expect(result.summary.totalLedgerSum).toBe(3000);
            expect(result.summary.difference).toBe(0);
            expect(result.discrepancies.length).toBe(0);
            expect(saveMock).toHaveBeenCalled();
            expect(logger.financial).toHaveBeenCalled();
        });

        test('يجب اكتشاف الفروقات وتحديد الأسباب المناسبة عند وجود تباين في الأرصدة', async () => {
            const userId = new mongoose.Types.ObjectId();
            const companyId = new mongoose.Types.ObjectId();
            const executorId = new mongoose.Types.ObjectId();

            const mockUsers = [{ _id: userId, name: 'User 1', balance: 550 }]; // فرق إيجابي (أكبر من الدفتر)
            const mockClientBots = [{ _id: companyId, name: 'Company A', balance: 950 }]; // فرق سلبي (أقل من الدفتر)
            const mockExecutors = [{ _id: executorId, name: 'Executor Group 1', balance: 1500 }]; // مطابق

            User.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(mockUsers) });
            ClientBot.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(mockClientBots) });
            ExecutorGroup.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(mockExecutors) });

            Ledger.aggregate = jest.fn()
                .mockResolvedValueOnce([{ _id: null, totalBalance: 500 }]) // User 1 لديه 500 في الدفتر ولكنه يملك 550 رصيد
                .mockResolvedValueOnce([{ _id: null, totalBalance: 1000 }]) // Company A لديه 1000 في الدفتر ولكنه يملك 950 رصيد
                .mockResolvedValueOnce([]); // Executor Group 1 ليس لديه قيود بالدفتر (0) ولكنه يملك 1500 رصيد

            // فحوصات السلامة
            Transaction.find = jest.fn().mockReturnValue({ distinct: jest.fn().mockResolvedValue([]) });
            Ledger.distinct = jest.fn().mockResolvedValue([]);

            const saveMock = jest.fn().mockResolvedValue({});
            Reconciliation.mockImplementation(function (data) {
                Object.assign(this, data);
                this.save = saveMock;
                return this;
            });

            const result = await reconcileDaily();

            expect(result.status).toBe('discrepancy_found');
            expect(result.summary.discrepancyCount).toBe(3); // لأن المنفذ أيضاً لديه فرق (1500 رصيد مقابل 0 بالدفتر)
            
            // التحقق من الفروقات والأسباب
            const diffUser = result.discrepancies.find(d => d.entityType === 'User');
            expect(diffUser.difference).toBe(50);
            expect(diffUser.possibleCause).toContain('missing DEBIT');

            const diffCompany = result.discrepancies.find(d => d.entityType === 'ClientBot');
            expect(diffCompany.difference).toBe(-50);
            expect(diffCompany.possibleCause).toContain('missing CREDIT');

            expect(saveMock).toHaveBeenCalled();
        });

        test('يجب كشف فحوصات السلامة للقيود اليتيمة بالكامل (Orphaned Transactions/Ledger Entries)', async () => {
            User.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
            ClientBot.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
            ExecutorGroup.find = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });

            // معاملة مكتملة TX-A غير موجودة بالدفتر (يتيمة)
            Transaction.find = jest.fn().mockReturnValue({
                distinct: jest.fn().mockResolvedValue(['TX-A', 'TX-B'])
            });
            // قيد بالدفتر TX-C ليس في قائمة المعاملات وليس SYS-SYNC (قيد يتيم)
            Ledger.distinct = jest.fn().mockResolvedValue(['TX-B', 'TX-C', 'SYS-SYNC']);

            const saveMock = jest.fn().mockResolvedValue({});
            Reconciliation.mockImplementation(function (data) {
                Object.assign(this, data);
                this.save = saveMock;
                return this;
            });

            const result = await reconcileDaily();

            expect(result.checks.ledgerIntegrity).toBe(false);
            expect(result.checks.orphanedTransactions).toBe(1); // TX-A
            expect(result.checks.orphanedLedgerEntries).toBe(1); // TX-C
        });

        test('يجب تسجيل الخطأ وعدم توقف السيرفر عند حدوث خطأ استثنائي أثناء المطابقة', async () => {
            User.find = jest.fn().mockReturnValue({
                lean: jest.fn().mockRejectedValue(new Error('DB Connection Failed'))
            });

            await expect(reconcileDaily()).rejects.toThrow('DB Connection Failed');
            expect(logger.error).toHaveBeenCalled();
        });
    });

    describe('detectDiscrepancies', () => {
        test('يجب إرجاع عدم وجود فروقات في حال عدم وجود مطابقة سابقة بالكامل', async () => {
            Reconciliation.findOne = jest.fn().mockReturnValue({
                sort: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue(null)
                })
            });

            const result = await detectDiscrepancies();
            expect(result.hasDiscrepancies).toBe(false);
            expect(result.message).toBe('No reconciliation found');
        });

        test('يجب إرجاع تفاصيل الفروقات إذا كانت حالة المطابقة الأخيرة discrepancy_found', async () => {
            const mockLatest = {
                status: 'discrepancy_found',
                reconciliationDate: new Date(),
                summary: { discrepancyCount: 2 },
                discrepancies: [{ entityName: 'User A', difference: 100 }]
            };

            Reconciliation.findOne = jest.fn().mockReturnValue({
                sort: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue(mockLatest)
                })
            });

            const result = await detectDiscrepancies();
            expect(result.hasDiscrepancies).toBe(true);
            expect(result.discrepancyCount).toBe(2);
            expect(result.discrepancies.length).toBe(1);
        });
    });

    describe('getReconciliationReports', () => {
        test('يجب جلب التقارير السابقة بنجاح مع الفرز والصفحات', async () => {
            const mockReports = [{ status: 'matched' }];

            Reconciliation.find = jest.fn().mockReturnValue({
                sort: jest.fn().mockReturnValue({
                    skip: jest.fn().mockReturnValue({
                        limit: jest.fn().mockReturnValue({
                            lean: jest.fn().mockResolvedValue(mockReports)
                        })
                    })
                })
            });

            const result = await getReconciliationReports({ limit: 10, skip: 5 });
            expect(result).toEqual(mockReports);
            expect(Reconciliation.find).toHaveBeenCalled();
        });
    });
});
