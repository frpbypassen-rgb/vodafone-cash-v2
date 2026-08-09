'use strict';

const {
    normalizeExecutorServiceKey,
    getExecutorSupportedTransferTypes,
    executorSupportsTransferType,
    executorTransferRequiresProof
} = require('../utils/executorServiceCatalog');

describe('executor service catalog', () => {
    test('normalizes legacy postal operation keys to the postal executor service', () => {
        expect(normalizeExecutorServiceKey('post_account')).toBe('postal');
        expect(normalizeExecutorServiceKey('post_card')).toBe('postal');
    });

    test('postal executor accepts postal account and card only', () => {
        const executor = { serviceKey: 'postal' };
        expect(getExecutorSupportedTransferTypes(executor)).toEqual(['post_account', 'post_card']);
        expect(executorSupportsTransferType(executor, 'post_account')).toBe(true);
        expect(executorSupportsTransferType(executor, 'post_card')).toBe(true);
        expect(executorSupportsTransferType(executor, 'vodafone')).toBe(false);
    });

    test('legacy executors without a service remain Vodafone-only', () => {
        expect(executorSupportsTransferType({}, 'vodafone')).toBe(true);
        expect(executorSupportsTransferType({}, 'bank_account')).toBe(false);
    });

    test('requires a completion proof for Sefa Niger only', () => {
        expect(executorTransferRequiresProof('sefa_niger')).toBe(true);
        expect(executorTransferRequiresProof('vodafone')).toBe(false);
        expect(executorTransferRequiresProof('post_account')).toBe(false);
    });
});
