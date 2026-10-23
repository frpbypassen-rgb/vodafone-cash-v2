'use strict';
const { canReviewProviderOperation, providerOperationMatches } = require('../utils/providerPendingOperation');

const tx = { status: 'processing', transferType: 'vodafone', amount: 100, vodafoneNumber: '01099887766', apiResultData: { providerTransactionId: '6103691' } };
const operation = { providerTransactionId: '6103691', amount: 100, phone: '01099887766' };

describe('pending API review eligibility and matching', () => {
    test.each([
        { providerTransactionId: '6103691' },
        { externalTransactionId: '6103691' },
        { providerTransactionNumber: '6103691' },
        { providerDispatchStartedAt: new Date(Date.now() - 600000) },
        { waitingApiAutoCompletion: true },
        { providerResultUnresolved: true }
    ])('recognizes legacy or incomplete API rows: %j', (data) => {
        expect(canReviewProviderOperation({ ...tx, apiResultData: data })).toBe(true);
    });
    test.each(['completed', 'rejected', 'cancelled_by_admin', 'deposit'])('never offers resolution for terminal/nontransfer status %s', (status) => {
        expect(canReviewProviderOperation({ ...tx, status })).toBe(false);
    });
    test('excludes ordinary manual tasks and already resolved API attempts', () => {
        expect(canReviewProviderOperation({ ...tx, apiResultData: { providerDispatchStartedAt: new Date() } })).toBe(false);
        expect(canReviewProviderOperation({ ...tx, apiResultData: {} })).toBe(false);
        expect(canReviewProviderOperation({ ...tx, apiResultData: { ...tx.apiResultData, providerResolutionOutcome: 'provider_not_paid' } })).toBe(false);
    });
    test('requires matching provider id, amount and recipient', () => {
        expect(providerOperationMatches(tx, operation)).toBe(true);
        expect(providerOperationMatches(tx, { ...operation, phone: '+201099887766' })).toBe(true);
        for (const change of [{ providerTransactionId: 'other' }, { amount: 101 }, { amount: null }, { phone: '' }, { phone: '01000000000' }]) {
            expect(providerOperationMatches(tx, { ...operation, ...change })).toBe(false);
        }
    });
});
