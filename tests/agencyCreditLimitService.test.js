'use strict';

const {
    AgencyCreditLimitError,
    normalizeCreditLimit,
    calculateCreditState,
    minimumBalanceForDebit,
    assertCreditLimitCanCoverBalance
} = require('../services/agencyCreditLimitService');

describe('Agency credit limit policy', () => {
    test('allows a zero-balance customer to use the agent-assigned debt limit', () => {
        const before = calculateCreditState({ balance: 0, creditLimit: 1000 });
        const debitThreshold = minimumBalanceForDebit(100, before.creditLimit);
        const after = calculateCreditState({ balance: -100, creditLimit: before.creditLimit });

        expect(0).toBeGreaterThanOrEqual(debitThreshold);
        expect(before.minimumBalance).toBe(-1000);
        expect(after.balance).toBe(-100);
        expect(after.debt).toBe(100);
        expect(after.usedCredit).toBe(100);
        expect(after.remainingCredit).toBe(900);
        expect(after.availableToSpend).toBe(900);
    });

    test('rejects a debit that would take the customer below the assigned limit', () => {
        const threshold = minimumBalanceForDebit(150, 1000);

        expect(-900).toBeLessThan(threshold);
        expect(threshold).toBe(-850);
    });

    test('does not accept negative, non-numeric, or oversized credit limits', () => {
        expect(() => normalizeCreditLimit(-1)).toThrow(AgencyCreditLimitError);
        expect(() => normalizeCreditLimit('not-a-number')).toThrow(AgencyCreditLimitError);
        expect(() => normalizeCreditLimit(1000000001)).toThrow(AgencyCreditLimitError);
        expect(normalizeCreditLimit('1000.1234')).toBe(1000.123);
    });

    test('prevents lowering a client limit below their current outstanding debt', () => {
        expect(() => assertCreditLimitCanCoverBalance({ balance: -100, creditLimit: 99 }))
            .toThrow(AgencyCreditLimitError);
        expect(assertCreditLimitCanCoverBalance({ balance: -100, creditLimit: 100 }))
            .toMatchObject({ minimumBalance: -100, debt: 100, remainingCredit: 0 });
    });
});
