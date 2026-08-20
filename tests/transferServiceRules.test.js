'use strict';

const { getTransferServiceRules, validateTransferInput } = require('../utils/transferServiceRules');

const validInput = {
    amount: 1000,
    destination: '01012345678',
    beneficiaryName: '',
    subtype: '',
    city: '',
    nationalId: '',
    governorate: '',
    hasIdentityImage: false
};

describe('Transfer service rules', () => {
    test('matches the cash and postal account fields used by the client portal', () => {
        expect(validateTransferInput({ ...validInput, serviceKey: 'vodafone' })).toBeNull();
        expect(validateTransferInput({ ...validInput, serviceKey: 'vodafone', destination: '01912345678' }))
            .toContain('رقم المحفظة');

        expect(validateTransferInput({
            ...validInput,
            serviceKey: 'post_account',
            destination: '123456789012345',
            beneficiaryName: 'محمد أحمد علي'
        })).toBeNull();
        expect(validateTransferInput({
            ...validInput,
            serviceKey: 'post_account',
            destination: '123456789012345',
            beneficiaryName: 'محمد أحمد'
        })).toContain('ثلاث');
    });

    test('requires the same structured fields for postal card transfers', () => {
        const postalCard = {
            ...validInput,
            serviceKey: 'post_card',
            destination: 'القاهرة',
            beneficiaryName: 'محمد أحمد علي محمود',
            nationalId: '12345678901234',
            governorate: 'القاهرة',
            hasIdentityImage: true
        };

        expect(validateTransferInput(postalCard)).toBeNull();
        expect(validateTransferInput({ ...postalCard, nationalId: '123' })).toContain('14');
        expect(validateTransferInput({ ...postalCard, hasIdentityImage: false })).toContain('صورة البطاقة');
    });

    test('requires city only for NITA, accepts 8-11 digit accounts, and rejects fractional Sefa amounts', () => {
        const sefa = {
            ...validInput,
            serviceKey: 'sefa_niger',
            destination: '12345678',
            beneficiaryName: 'محمد',
            subtype: 'nita'
        };

        expect(validateTransferInput(sefa)).toContain('المدينة');
        expect(validateTransferInput({ ...sefa, city: 'نيامي' })).toBeNull();
        expect(validateTransferInput({ ...sefa, destination: '123456789', city: 'نيامي' })).toBeNull();
        expect(validateTransferInput({ ...sefa, destination: '1234567890', city: 'نيامي' })).toBeNull();
        expect(validateTransferInput({ ...sefa, destination: '1234567', city: 'نيامي' })).toContain('8 إلى 11');
        expect(validateTransferInput({ ...sefa, destination: '12345678901', city: 'نيامي' })).toBeNull();
        expect(validateTransferInput({ ...sefa, destination: '123456789012', city: 'نيامي' })).toContain('8 إلى 11');
        expect(validateTransferInput({ ...sefa, subtype: 'nita_account' })).toBeNull();
        expect(validateTransferInput({ ...sefa, subtype: 'nita_account', amount: 1000.5 })).toContain('كسور');
        expect(validateTransferInput({
            ...sefa,
            subtype: 'nita_account',
            enforceDataEntryAcknowledgement: true
        })).toContain('تأكيد مسؤوليتك');
        expect(validateTransferInput({
            ...sefa,
            subtype: 'nita_account',
            enforceDataEntryAcknowledgement: true,
            dataEntryAcknowledged: true
        })).toBeNull();
        expect(getTransferServiceRules('sefa_niger').destinationMaxLength).toBe(11);
    });
});
