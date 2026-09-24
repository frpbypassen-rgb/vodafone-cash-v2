'use strict';

const {
    BankTransferExecutionError,
    assertBankTransferDestination,
    isBankTransferOperation,
    prepareBankTransferCompletion
} = require('../utils/bankTransferExecution');

describe('bank transfer execution', () => {
    test('uses the existing bank_account service key and the legacy bank_transfer alias', () => {
        expect(isBankTransferOperation({ transferType: 'bank_account' })).toBe(true);
        expect(isBankTransferOperation({ transferType: 'bank_transfer' })).toBe(true);
        expect(isBankTransferOperation({ canonicalServiceKey: 'bank_account', transferType: 'vodafone' })).toBe(true);
        expect(isBankTransferOperation({ transferType: 'vodafone' })).toBe(false);
        expect(isBankTransferOperation({ transferType: 'sefa_niger' })).toBe(false);
        expect(isBankTransferOperation({ transferType: 'post_account' })).toBe(false);
    });

    test('requires one proof image and rejects a split payment', () => {
        expect(prepareBankTransferCompletion({
            imageBase64: 'data:image/png;base64,abc'
        }).proofs).toEqual(['data:image/png;base64,abc']);

        expect(() => prepareBankTransferCompletion({})).toThrow(BankTransferExecutionError);
        expect(() => prepareBankTransferCompletion({})).toThrow('إرفاق صورة إثبات التحويل البنكي إجباري.');
        expect(() => prepareBankTransferCompletion({
            imagesBase64: ['data:image/png;base64,abc'],
            senderEntries: [{ phone: '01108172258', amount: 40 }, { phone: '01095433913', amount: 60 }]
        })).toThrow('التحويل البنكي يُنفَّذ دفعة واحدة ولا يقبل التقسيم.');
    });

    test('requires an allowlisted Egyptian bank for bank transfers and ignores it for cash', () => {
        expect(assertBankTransferDestination({
            transferType: 'bank_account',
            bankCode: 'cib'
        })).toMatchObject({ code: 'cib', nameAr: 'البنك التجاري الدولي CIB' });
        expect(assertBankTransferDestination({
            transferType: 'bank_transfer',
            serviceSubtype: 'instapay',
            bankName: 'بنك قطر الوطني الأهلي QNB'
        })).toMatchObject({ code: 'qnb' });

        expect(() => assertBankTransferDestination({ transferType: 'bank_account' }))
            .toThrow('اختر البنك قبل إرسال التحويل البنكي.');
        expect(() => assertBankTransferDestination({
            transferType: 'bank_transfer',
            bankName: 'البنك المركزي المصري'
        })).toThrow('غير مدرج');
        expect(assertBankTransferDestination({ transferType: 'vodafone' })).toBeNull();
        expect(assertBankTransferDestination({ transferType: 'post_account', bankName: 'بنك خيالي' })).toBeNull();
    });
});
