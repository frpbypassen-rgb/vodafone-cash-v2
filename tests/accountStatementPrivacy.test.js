'use strict';

const ejs = require('ejs');
const path = require('path');
const { buildStatementLedgerQuery } = require('../services/adminReportService');
const { preparePdfReport } = require('../services/reportPdfService');
const {
    sanitizeAccountStatementReport,
    sanitizeStatementMovement,
    sanitizeStatementTransaction
} = require('../utils/accountStatementPrivacy');

const transactionFixture = (overrides = {}) => ({
    _id: '507f1f77bcf86cd799439011',
    customId: 'ATT-2608-0099',
    transferType: 'vodafone',
    vodafoneNumber: '01000000000',
    amount: 1600,
    costLYD: 320,
    exchangeRate: 5,
    status: 'completed',
    customerNotes: 'ملاحظة العميل',
    notes: 'ملاحظة العميل\n[الرقم المرجعي: REF-778]\n[رقم المرسل: 01108172258]\n[تم التوجيه إلى المنفذ]',
    adminNotes: '[تم الإلغاء | المنفذ: منفذ القاهرة | السبب: المستلم لم يرد]',
    executorGroupId: '507f1f77bcf86cd799439012',
    managerGroupId: '507f1f77bcf86cd799439013',
    operatorId: '507f1f77bcf86cd799439014',
    executorName: 'منفذ القاهرة',
    executorSenderPhone: '01108172258',
    apiResultData: { provider: 'secret-provider', balance: 1000 },
    createdAt: new Date('2026-08-07T10:00:00.000Z'),
    updatedAt: new Date('2026-08-07T10:01:00.000Z'),
    ...overrides
});

const baseReport = (transaction) => ({
    success: true,
    scope: { mainCategory: 'direct_client', subId: 'client-1', subType: 'all' },
    entityInfo: { name: 'عميل الاختبار', phone: '0911111111', status: 'عميل مباشر' },
    range: {
        dateType: 'day',
        start: new Date('2026-08-07T00:00:00.000Z'),
        end: new Date('2026-08-07T23:59:59.999Z')
    },
    stats: {
        isExecutor: false,
        accountingCurrency: 'LYD',
        previousBalance: 0,
        operationsCost: 320,
        totalEGP: 1600,
        totalDeposits: 0,
        totalDeductions: 0,
        dailyNet: -320,
        endingBalance: -320,
        cancelledEGP: 0,
        cancelledLYD: 0
    },
    completedOperations: [transaction],
    pendingOperations: [],
    cancelledOperations: [],
    deposits: [],
    deductions: [],
    pendingDeposits: [],
    operations: [transaction],
    depositsAndDeductions: [],
    movements: [{
        transactionId: transaction.customId,
        entityModel: 'User',
        type: 'TRANSFER',
        amount: -320,
        balanceBefore: 0,
        balanceAfter: -320,
        description: 'خصم بواسطة المنفذ منفذ القاهرة',
        createdAt: transaction.createdAt
    }, {
        transactionId: transaction.customId,
        entityModel: 'ExecutorGroup',
        type: 'TRANSFER',
        amount: -1600,
        balanceBefore: 5000,
        balanceAfter: 3400,
        description: 'قيد المنفذ',
        createdAt: transaction.createdAt
    }],
    closedDayChanges: [{
        transactionId: transaction.customId,
        action: 'تغيير منفذ العملية',
        actor: 'منفذ القاهرة',
        details: 'تم تغيير المنفذ بعد الإقفال'
    }],
    closure: { closedDayCount: 1, hasPostCloseChanges: true, status: 'closed' }
});

describe('Account statement executor privacy', () => {
    test('removes every executor and API field while preserving customer note and reference', () => {
        const transaction = sanitizeStatementTransaction(transactionFixture());

        expect(transaction).not.toHaveProperty('executorGroupId');
        expect(transaction).not.toHaveProperty('managerGroupId');
        expect(transaction).not.toHaveProperty('operatorId');
        expect(transaction).not.toHaveProperty('executorName');
        expect(transaction).not.toHaveProperty('executorSenderPhone');
        expect(transaction).not.toHaveProperty('apiResultData');
        expect(transaction.notes).toBe('ملاحظة العميل\n[الرقم المرجعي: REF-778]');
        expect(JSON.stringify(transaction)).not.toContain('01108172258');
        expect(JSON.stringify(transaction)).not.toContain('منفذ القاهرة');
    });

    test('extracts a useful cancellation reason without exposing the executor', () => {
        const transaction = sanitizeStatementTransaction(transactionFixture({
            status: 'cancelled_by_admin',
            cancellationReason: '[تم الإلغاء | المنفذ: منفذ القاهرة | السبب: المستلم لم يرد]'
        }));

        expect(transaction.cancellationReason).toBe('المستلم لم يرد');
        expect(transaction.cancellationReason).not.toContain('المنفذ');
    });

    test('excludes executor ledger rows and replaces executor descriptions', () => {
        expect(sanitizeStatementMovement({ entityModel: 'ExecutorGroup' })).toBeNull();
        expect(sanitizeStatementMovement({
            entityModel: 'User',
            type: 'TRANSFER',
            description: 'خصم بواسطة المنفذ منفذ القاهرة'
        })).toMatchObject({ description: 'تحويل مالي' });

        expect(buildStatementLedgerQuery(['ATT-1'], false)).toEqual({
            transactionId: { $in: ['ATT-1'] },
            entityModel: { $nin: ['ExecutorBot', 'ExecutorGroup'] }
        });
    });

    test('removes executor audit changes from customer account statements', () => {
        const report = sanitizeAccountStatementReport(baseReport(transactionFixture()));

        expect(report.closedDayChanges).toEqual([]);
        expect(report.stats).not.toHaveProperty('isExecutor');
        expect(report.movements).toHaveLength(1);
        expect(report.movements[0].entityModel).toBe('User');
        expect(JSON.stringify(report)).not.toContain('منفذ القاهرة');
        expect(JSON.stringify(report)).not.toContain('01108172258');
    });

    test('renders a customer PDF without executor columns or values', async () => {
        const report = preparePdfReport(baseReport(transactionFixture()));
        const html = await ejs.renderFile(path.join(__dirname, '../views/reports_pdf.ejs'), {
            report,
            generatedAt: new Date('2026-08-07T12:00:00.000Z'),
            adminName: 'الإدارة',
            logoDataUri: ''
        });

        expect(html).toContain('ملاحظة العميل');
        expect(html).toContain('REF-778');
        expect(html).not.toContain('منفذ القاهرة');
        expect(html).not.toContain('01108172258');
        expect(html).not.toMatch(/<th[^>]*>المنفذ<\/th>/);
    });
});
