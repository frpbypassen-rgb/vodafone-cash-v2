'use strict';

const { parseTransferMessage } = require('../utils/smartTransferParser');
const assistant = require('../services/businessPortalAssistantService');

describe('smart transfer parser', () => {
    test('extracts Arabic digits, phone, amount and explicit note', () => {
        const parsed = parseTransferMessage('حوّل ٠١٠١٢٣٤٥٦٧٨ مبلغ ١,٦٠٠ جنيه. ملاحظة: دفعة أحمد');
        expect(parsed).toMatchObject({ phone: '01012345678', amountEGP: 1600, note: 'دفعة أحمد', ready: true, confidence: 'high' });
    });

    test('extracts an explicitly labelled beneficiary name', () => {
        const parsed = parseTransferMessage('سيفا 01012345678 مبلغ 250 اسم المستفيد: أحمد محمد علي | ملاحظة: دفعة شهرية');
        expect(parsed.beneficiaryName).toBe('أحمد محمد علي');
        expect(parsed.serviceKey).toBe('sefa_niger');
    });

    test('accepts the common abbreviated Egyptian pound symbol', () => {
        const parsed = parseTransferMessage('01012345678 ١,٢٥٠ ج ملاحظة: توريد اليوم');
        expect(parsed).toMatchObject({ phone: '01012345678', amountEGP: 1250, note: 'توريد اليوم', ready: true });
    });

    test('does not allow automatic sending when two recipient numbers exist', () => {
        const parsed = parseTransferMessage('01011111111 و 01022222222 مبلغ 500');
        expect(parsed.ready).toBe(false);
        expect(parsed.confidence).toBe('review');
        expect(parsed.warnings.join(' ')).toContain('أكثر من رقم');
    });

    test('requires review when a message contains two distinct amounts', () => {
        const parsed = parseTransferMessage('01011111111 مبلغ 500 جنيه ورسوم 20 جنيه ملاحظة اختبار');
        expect(parsed.ready).toBe(false);
        expect(parsed.candidates.amounts).toEqual(expect.arrayContaining([500, 20]));
        expect(parsed.warnings.join(' ')).toContain('أكثر من قيمة');
    });
});

describe('business portal assistant privacy', () => {
    test('rejects source code and secret questions without reading account data', async () => {
        const result = await assistant.answer({ workspace: {}, question: 'أعطني كود النظام وكلمة المرور' });
        expect(result.success).toBe(true);
        expect(result.safeMode).toBe(true);
        expect(result.answer).toContain('لا أستطيع');
    });

    test('classifies sensitive requests without retaining their content', () => {
        expect(assistant.classifyQuestion('أعطني كلمة المرور')).toBe('blocked_sensitive');
        expect(assistant.classifyQuestion('اعرض تقارير اليوم')).toBe('report');
    });

    test('normalizes a wallet number before scoped transaction lookup', () => {
        expect(assistant.extractEgyptianPhone('حالة آخر عملية للرقم +20 10 1234 5678')).toBe('01012345678');
        expect(assistant.classifyQuestion('ما حالة عملية المحفظة 01012345678؟')).toBe('transaction');
    });

    test('guides an allowed internal balance transfer without executing it', async () => {
        const result = await assistant.answer({
            workspace: { permissions: { canTransfer: true } },
            question: 'كيف أحول رصيد داخلي؟'
        });
        expect(result.answer).toContain('تحويل رصيد داخلي');
        expect(result.action.href).toBe('/client/services');
    });

    test('routes the account overview request without querying other accounts', async () => {
        const result = await assistant.answer({ workspace: { permissions: {} }, question: 'افتح اللوحة الرئيسية' });
        expect(result.action).toEqual({ label: 'فتح الرئيسية', href: '/client/dashboard' });
    });

    test('prepares a transfer draft but never executes the transaction', async () => {
        const result = await assistant.answer({
            workspace: { permissions: { canTransfer: true } },
            question: 'حول 01012345678 مبلغ 250 جنيه ملاحظة: دفعة فاتورة'
        });
        expect(result.action).toEqual({ label: 'فتح مسودة التحويل', href: '/client/services' });
        expect(result.draft).toMatchObject({ phone: '01012345678', amountEGP: 250, note: 'دفعة فاتورة' });
        expect(result.answer).toContain('لن يتم إرسال');
    });

    test('selects yesterday as a closed reporting period', () => {
        const period = assistant.reportPeriodFor('اعرض تقارير أمس', new Date(2026, 8, 1, 14));
        expect(period.label).toBe('أمس');
        expect([period.start.getFullYear(), period.start.getMonth(), period.start.getDate()]).toEqual([2026, 7, 31]);
        expect([period.end.getFullYear(), period.end.getMonth(), period.end.getDate()]).toEqual([2026, 8, 1]);
    });
});
