'use strict';

const {
    parseTransferMessage,
    normalizeDigits,
    normalizeAmountToken
} = require('../utils/smartTransferParser');

describe('Smart transfer message parser', () => {
    test('normalizes Arabic digits and thousands separators', () => {
        expect(normalizeDigits('٠١٠١٢٣٤٥٦٧٨')).toBe('01012345678');
        expect(normalizeAmountToken('١٬٦٠٠')).toBe(1600);
        expect(normalizeAmountToken('1,600.50')).toBe(1600.5);
    });

    test('extracts an Egyptian phone, EGP amount, note, and cash service', () => {
        expect(parseTransferMessage('كاش ٠١٠١٢٣٤٥٦٧٨\nالمبلغ: ١٬٦٠٠ جنيه\nملاحظة: دفعة أحمد')).toEqual({
            phone: '01012345678',
            amountEGP: 1600,
            note: 'دفعة أحمد',
            serviceKey: 'vodafone',
            ready: true,
            missing: []
        });
    });

    test('normalizes an Egyptian international phone and detects a bank transfer', () => {
        const parsed = parseTransferMessage('تحويل بنكي +20 11 2345 6789 بقيمة 2500 EGP ملاحظة: فاتورة 18');

        expect(parsed).toMatchObject({
            phone: '01123456789',
            amountEGP: 2500,
            note: 'فاتورة 18',
            serviceKey: 'bank_account',
            ready: true
        });
    });

    test('uses a plain numeric amount without mistaking the phone for the amount', () => {
        expect(parseTransferMessage('01012345678 3200 طلب محمد')).toMatchObject({
            phone: '01012345678',
            amountEGP: 3200,
            note: 'طلب محمد',
            ready: true
        });
    });

    test('reports missing amount when a message only contains a phone', () => {
        expect(parseTransferMessage('حول على 01012345678 كاش')).toMatchObject({
            phone: '01012345678',
            amountEGP: null,
            ready: false,
            missing: ['المبلغ بالجنيه']
        });
        expect(parseTransferMessage('حول على 010 1234 5678 كاش')).toMatchObject({
            phone: '01012345678',
            amountEGP: null,
            ready: false,
            missing: ['المبلغ بالجنيه']
        });
        expect(parseTransferMessage('01012345678 ملاحظة: فاتورة 18')).toMatchObject({
            phone: '01012345678',
            amountEGP: null,
            note: 'فاتورة 18',
            ready: false,
            missing: ['المبلغ بالجنيه']
        });
    });

    test('detects specific services before generic bank wording', () => {
        expect(parseTransferMessage('بنكك السودان 01012345678 مبلغ 900 جنيه').serviceKey).toBe('bankak_sudan');
        expect(parseTransferMessage('بريد بطاقة 01012345678 مبلغ 900 جنيه').serviceKey).toBe('post_card');
        expect(parseTransferMessage('NITA 01012345678 مبلغ 900 جنيه').serviceKey).toBe('sefa_niger');
    });
});
