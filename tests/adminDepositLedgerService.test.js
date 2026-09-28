'use strict';

jest.mock('../middlewares/tenantResolver', () => ({ tenantMode: () => 'single' }));

const {
    buildAdminDepositQuery,
    classifyDepositParty,
    companySupportDepositRows
} = require('../services/adminDepositLedgerService');
const { mongoQueryMatches } = require('./mongoQueryMatch');

const companyDeposit = {
    status: 'deposit',
    companyId: 'company-1',
    companyName: 'شركة النور',
    amount: 250,
    userId: 'admin'
};

const executorDeposit = {
    status: 'deposit_pending',
    executorGroupId: 'executor-1',
    companyName: 'منفذ كاش',
    userId: 'admin',
    amount: 1000,
    depositRequest: { submittedByRole: 'executor' }
};

const executorSettlement = {
    status: 'deduction',
    executorGroupId: 'executor-1',
    transferType: 'external_balance',
    amount: 40
};

const retailDeposit = {
    status: 'deposit',
    userId: '0910000000',
    companyName: 'عميل مباشر',
    amount: 80
};

const completedTransfer = {
    status: 'completed',
    companyId: 'company-1',
    executorGroupId: 'executor-1',
    amount: 500
};

const agencyDeposit = {
    status: 'deposit',
    companyId: 'company-1',
    isSubAccountTx: true,
    subAccountId: 'sub-1',
    amount: 15
};

describe('admin deposit ledger queries', () => {
    test('includes company and executor deposits and drops transfers and agency funding', () => {
        const companyQuery = buildAdminDepositQuery({ party: 'company' });
        const executorQuery = buildAdminDepositQuery({ party: 'executor' });
        const allQuery = buildAdminDepositQuery({ party: 'all' });

        expect(mongoQueryMatches(companyDeposit, companyQuery)).toBe(true);
        expect(mongoQueryMatches(executorDeposit, companyQuery)).toBe(false);
        expect(mongoQueryMatches(executorDeposit, executorQuery)).toBe(true);
        expect(mongoQueryMatches(executorSettlement, executorQuery)).toBe(true);
        expect(mongoQueryMatches(companyDeposit, executorQuery)).toBe(false);
        expect(mongoQueryMatches(retailDeposit, allQuery)).toBe(true);
        expect(mongoQueryMatches(companyDeposit, allQuery)).toBe(true);
        expect(mongoQueryMatches(executorDeposit, allQuery)).toBe(true);
        expect(mongoQueryMatches(completedTransfer, allQuery)).toBe(false);
        expect(mongoQueryMatches(completedTransfer, companyQuery)).toBe(false);
        expect(mongoQueryMatches(agencyDeposit, companyQuery)).toBe(false);
        expect(mongoQueryMatches(agencyDeposit, allQuery)).toBe(false);
        expect(classifyDepositParty(companyDeposit)).toBe('company');
        expect(classifyDepositParty(executorDeposit)).toBe('executor');
        expect(classifyDepositParty(retailDeposit)).toBe('client');
    });

    test('keeps company deposit requests that only exist on support tickets', () => {
        const rows = companySupportDepositRows({
            _id: 'ticket-1',
            entityType: 'client_company',
            ticketId: 'TCK-9',
            name: 'شركة النور',
            status: 'open',
            messages: [
                { text: 'مرحبا', createdAt: '2026-09-01T00:00:00.000Z' },
                {
                    text: 'طلب إيداع رصيد\nالقيمة: 250.50 LYD\nالملاحظة: حوالة مصرف ليبيا',
                    createdAt: '2026-09-02T00:00:00.000Z'
                }
            ]
        });

        expect(rows).toEqual([
            expect.objectContaining({
                party: 'company',
                source: 'support',
                reference: 'TCK-9',
                amount: 250.5,
                status: 'deposit_pending',
                note: 'حوالة مصرف ليبيا'
            })
        ]);
        expect(companySupportDepositRows({
            entityType: 'executor_group',
            messages: [{ text: 'طلب إيداع رصيد\nالقيمة: 10 LYD\nالملاحظة: لا' }]
        })).toEqual([]);
    });
});
