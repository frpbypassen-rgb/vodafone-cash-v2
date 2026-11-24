'use strict';

const {
    isSimpleExecutor,
    parseSimpleCompletionInput
} = require('../utils/executorSimpleView');
const { maskManualExecutionNumber } = require('../utils/manualExecutorReceipt');

describe('opt-in simple executor view', () => {
    test('only a manual operator or external executor can use it', () => {
        expect(isSimpleExecutor({ role: 'operator', simpleTaskViewEnabled: true, groupId: { isApiBot: false } })).toBe(true);
        expect(isSimpleExecutor({ role: 'external', simpleTaskViewEnabled: true, groupId: { isApiBot: false } })).toBe(true);
        expect(isSimpleExecutor({ role: 'manager', simpleTaskViewEnabled: true, groupId: {} })).toBe(false);
        expect(isSimpleExecutor({ role: 'operator', simpleTaskViewEnabled: true, groupId: { isApiBot: true } })).toBe(false);
        expect(isSimpleExecutor({ role: 'operator', simpleTaskViewEnabled: false, groupId: {} })).toBe(false);
    });

    test.each(['123', '1234', '12345', '1234567890', '12345678901'])(
        'accepts a %s execution number without an image', (number) => {
            expect(parseSimpleCompletionInput({ body: { executionNumber: number }, proofCount: 0 }))
                .toBe(number);
            expect(maskManualExecutionNumber(number, { allowSimpleRange: true })).not.toBe(number);
        }
    );

    test('accepts image only and rejects a completion with neither proof nor number', () => {
        expect(parseSimpleCompletionInput({ body: {}, proofCount: 1 })).toBe('');
        expect(() => parseSimpleCompletionInput({ body: {}, proofCount: 0 })).toThrow(/صورة|رقم/);
    });

    test.each(['12', '123456789012', '123x4', ' 123 45 ', '+21891000123'])(
        'rejects an invalid execution number %s even when an image is attached', (number) => {
            expect(() => parseSimpleCompletionInput({ body: { executionNumber: number }, proofCount: 1 }))
                .toThrow(/3.*11/);
        }
    );

    test('does not accept split entries in the single-task interface', () => {
        expect(() => parseSimpleCompletionInput({
            body: { senderEntries: [{ phone: '123', amount: 100 }] }, proofCount: 1
        })).toThrow(/تقسيم/);
    });

    test('keeps the existing manual receipt validation unchanged', () => {
        expect(() => maskManualExecutionNumber('12345')).toThrow();
    });
});
