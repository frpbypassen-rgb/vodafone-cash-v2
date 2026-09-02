'use strict';

const {
    buildExecutorOperationSearchQuery,
    parseAmount
} = require('../utils/executorOperationSearch');

describe('executor operation search', () => {
    test('normalizes Arabic phone digits and searches every supported recipient field', () => {
        const result = buildExecutorOperationSearchQuery('٠١٠٠١٣٥٢٠٣٤');

        expect(result).toEqual(expect.objectContaining({
            active: true,
            kind: 'phone',
            value: '01001352034'
        }));
        expect(result.query.$or).toEqual(expect.arrayContaining([
            expect.objectContaining({ vodafoneNumber: expect.any(RegExp) }),
            expect.objectContaining({ accountNumber: expect.any(RegExp) }),
            expect.objectContaining({ 'executorSenderEntries.phone': expect.any(RegExp) })
        ]));
        const phonePattern = result.query.$or[0].vodafoneNumber;
        expect(phonePattern.test('010 0135-2034')).toBe(true);
        expect(phonePattern.test('+20 1001352034')).toBe(true);
    });

    test('recognizes the transfer-notice amount formats used by executors', () => {
        expect(parseAmount('2٫000مصري')).toBe(2000);
        expect(parseAmount('1350 ج')).toBe(1350);
        expect(parseAmount('1,000.50 EGP')).toBe(1000.5);

        const result = buildExecutorOperationSearchQuery('١٣٥٠ ج.م');
        expect(result).toEqual(expect.objectContaining({
            active: true,
            kind: 'amount',
            value: 1350
        }));
        expect(result.query.amount).toEqual({ $gte: 1349.99999, $lte: 1350.00001 });
    });

    test('escapes non-financial references instead of accepting a raw regexp', () => {
        const result = buildExecutorOperationSearchQuery('ATT-1.*');
        const referencePattern = result.query.$or[0].customId;

        expect(result.kind).toBe('reference');
        expect(referencePattern.test('ATT-1.*-safe')).toBe(true);
        expect(referencePattern.test('ATT-12345')).toBe(false);
    });
});
