'use strict';

const {
    normalizeCustomerNoteInput,
    extractLegacyCustomerNote,
    customerNoteFromTransaction
} = require('../utils/transactionNotes');

describe('Transaction customer notes', () => {
    test('normalizes note aliases used by web and mobile clients', () => {
        expect(normalizeCustomerNoteInput({ notes: '  اتصل بالمستفيد أولاً  ' })).toBe('اتصل بالمستفيد أولاً');
        expect(normalizeCustomerNoteInput({ customerNote: 'ملاحظة الشركة' })).toBe('ملاحظة الشركة');
        expect(normalizeCustomerNoteInput({ note: 'ملاحظة بديلة' })).toBe('ملاحظة بديلة');
    });

    test('keeps the explicit customer note separate from execution logs', () => {
        const transaction = {
            customerNotes: 'ملاحظة العميل الأصلية',
            notes: 'ملاحظة العميل الأصلية\n[تم توجيه العملية إلى المنفذ]\n--- سجل الـ API ---\nOK'
        };

        expect(customerNoteFromTransaction(transaction)).toBe('ملاحظة العميل الأصلية');
    });

    test('keeps the operation reference but removes executor sender data', () => {
        const transaction = {
            customerNotes: 'ملاحظة العميل',
            notes: 'ملاحظة العميل\n[الرقم المرجعي: REF-778]\n[تم التنفيذ]',
            executorSenderPhone: '01100000000'
        };

        expect(customerNoteFromTransaction(transaction)).toBe(
            'ملاحظة العميل\n[الرقم المرجعي: REF-778]'
        );
    });

    test('extracts customer text from legacy mixed notes', () => {
        expect(extractLegacyCustomerNote('يرجى التنفيذ سريعاً\n[تم توجيه العملية]\n[الرقم المرجعي: REF-22]'))
            .toBe('يرجى التنفيذ سريعاً\n[الرقم المرجعي: REF-22]');
    });
});
