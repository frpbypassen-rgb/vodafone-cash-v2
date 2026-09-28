'use strict';

const {
    BANK_INVALID_ERROR,
    BANK_REQUIRED_ERROR,
    EGYPTIAN_BANKS,
    bankLabelForTransaction,
    formatClientReceiptAccountName,
    normalizeStoredBank,
    resolveEgyptianBank
} = require('../utils/egyptianBanks');

describe('Egyptian bank allowlist', () => {
    test('lists active customer banks and skips the central bank', () => {
        expect(EGYPTIAN_BANKS.length).toBeGreaterThan(30);
        expect(EGYPTIAN_BANKS.map((bank) => bank.code)).toEqual(
            expect.arrayContaining(['nbe', 'bmisr', 'cib', 'qnb', 'bdc', 'saib', 'hsbc', 'abe'])
        );
        const names = EGYPTIAN_BANKS.map((bank) => bank.nameAr).join(' ');
        expect(names).toContain('البنك الأهلي المصري');
        expect(names).toContain('بنك بلوم مصر');
        expect(names).toContain('التجاري وفا');
        expect(names).not.toMatch(/المركزي/);
        expect(resolveEgyptianBank('البنك المركزي المصري')).toBeNull();
        expect(resolveEgyptianBank('فودافون كاش')).toBeNull();
    });

    test('resolves stable codes, Arabic names, and known aliases', () => {
        expect(resolveEgyptianBank('NBE')).toMatchObject({ code: 'nbe', nameAr: 'البنك الأهلي المصري' });
        expect(resolveEgyptianBank('  بنك مصر ')).toMatchObject({ code: 'bmisr' });
        expect(resolveEgyptianBank('saib')).toMatchObject({ code: 'saib' });
        expect(resolveEgyptianBank('بنك المشرق مصر')).toMatchObject({ code: 'mashreq' });
        expect(resolveEgyptianBank('الاهلي المتحد')).not.toMatchObject({ code: 'nbe' });
    });

    test('requires a listed bank only for bank transfer services, including Instapay on the same key', () => {
        expect(normalizeStoredBank({ transferType: 'vodafone' })).toMatchObject({ required: false, error: null });
        expect(normalizeStoredBank({ transferType: 'post_account', bankName: 'بنك غير موجود' }).error).toBeNull();

        expect(normalizeStoredBank({ transferType: 'bank_account', serviceSubtype: 'instapay' })).toMatchObject({
            required: true,
            error: BANK_REQUIRED_ERROR,
            code: 'BANK_REQUIRED'
        });
        expect(normalizeStoredBank({
            transferType: 'bank_transfer',
            bankName: 'بنك وهمي'
        })).toMatchObject({
            error: BANK_INVALID_ERROR,
            code: 'BANK_INVALID'
        });
        expect(normalizeStoredBank({
            canonicalServiceKey: 'bank_account',
            transferType: 'vodafone',
            bankCode: 'cib'
        }).bank).toMatchObject({ code: 'cib', nameAr: 'البنك التجاري الدولي CIB' });
    });

    test('shows the stored Arabic bank name on receipts that already name the beneficiary', () => {
        const transaction = {
            transferType: 'bank_account',
            accountName: 'محمد أحمد علي',
            serviceDetails: { bankCode: 'nbe', bankName: 'البنك الأهلي المصري' }
        };
        expect(bankLabelForTransaction(transaction)).toBe('البنك الأهلي المصري');
        expect(formatClientReceiptAccountName(transaction, 'محمد أحمد علي'))
            .toBe('محمد أحمد علي — البنك الأهلي المصري');
        expect(formatClientReceiptAccountName(transaction, 'شركة الأهرام')).toBe('شركة الأهرام');
        expect(formatClientReceiptAccountName({
            transferType: 'vodafone',
            accountName: 'محمد أحمد علي'
        }, 'محمد أحمد علي')).toBe('محمد أحمد علي');
    });
});
