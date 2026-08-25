'use strict';

const {
    ExecutorSenderEntriesError,
    normalizeExecutorSenderEntries
} = require('../utils/executorSenderEntries');

describe('executor sender entries', () => {
    test('allows completing without a sender number', () => {
        expect(normalizeExecutorSenderEntries({ operationAmount: 100 })).toEqual([]);
    });

    test('assigns the operation amount automatically for one sender number', () => {
        expect(normalizeExecutorSenderEntries({
            operationAmount: 100,
            requestedSenderEntries: [{ phone: '01108172258' }]
        })).toEqual([{ phone: '01108172258', amount: 100, proofImage: null }]);
    });

    test('requires and validates an amount for every sender when multiple are entered', () => {
        expect(normalizeExecutorSenderEntries({
            operationAmount: 100,
            requestedSenderEntries: [
                { phone: '01108172258', amount: 40 },
                { phone: '01095433913', amount: 60 }
            ]
        })).toEqual([
            { phone: '01108172258', amount: 40, proofImage: null },
            { phone: '01095433913', amount: 60, proofImage: null }
        ]);

        expect(() => normalizeExecutorSenderEntries({
            operationAmount: 100,
            requestedSenderEntries: [
                { phone: '01108172258', amount: 40 },
                { phone: '01095433913' }
            ]
        })).toThrow(expect.objectContaining({ code: 'SENDER_AMOUNTS_REQUIRED' }));
    });

    test('rejects sender totals that do not match the operation', () => {
        expect(() => normalizeExecutorSenderEntries({
            operationAmount: 100,
            requestedSenderEntries: [
                { phone: '01108172258', amount: 40 },
                { phone: '01095433913', amount: 50 }
            ]
        })).toThrow(expect.objectContaining({
            code: 'SENDER_AMOUNT_MISMATCH'
        }));
    });

    test('rejects malformed sender numbers', () => {
        expect(() => normalizeExecutorSenderEntries({
            operationAmount: 100,
            requestedSenderEntries: [{ phone: '899' }],
            policy: { allowedPhoneLengths: [11], splitRequiresFullPhone: true, proofRequired: false }
        })).toThrow(expect.objectContaining({
            code: 'INVALID_SENDER_PHONE'
        }));
    });

    test('allows configured short sender numbers for single-entry completion', () => {
        expect(normalizeExecutorSenderEntries({
            operationAmount: 100,
            requestedSenderEntries: [{ phone: '2258' }],
            policy: { allowedPhoneLengths: [3, 4, 11], splitRequiresFullPhone: true, proofRequired: false }
        })).toEqual([{ phone: '2258', amount: 100, proofImage: null }]);
    });

    test('requires full phone numbers when split completion is configured that way', () => {
        expect(() => normalizeExecutorSenderEntries({
            operationAmount: 100,
            requestedSenderEntries: [
                { phone: '2258', amount: 40 },
                { phone: '01095433913', amount: 60 }
            ],
            policy: { allowedPhoneLengths: [3, 4, 11], splitRequiresFullPhone: true, proofRequired: false }
        })).toThrow(expect.objectContaining({ code: 'INVALID_SENDER_PHONE' }));
    });

    test('requires proof images when manual proof is mandatory', () => {
        expect(() => normalizeExecutorSenderEntries({
            operationAmount: 100,
            requestedSenderEntries: [{ phone: '01108172258' }],
            policy: { allowedPhoneLengths: [11], splitRequiresFullPhone: true, proofRequired: true }
        })).toThrow(expect.objectContaining({ code: 'PROOF_REQUIRED' }));
    });
});
