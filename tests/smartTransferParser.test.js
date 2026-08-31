'use strict';

const { parseTransferMessage } = require('../utils/smartTransferParser');
const assistant = require('../services/businessPortalAssistantService');

describe('smart transfer parser', () => {
    test('extracts Arabic digits, phone, amount and explicit note', () => {
        const parsed = parseTransferMessage('حوّل ٠١٠١٢٣٤٥٦٧٨ مبلغ ١,٦٠٠ جنيه. ملاحظة: دفعة أحمد');
        expect(parsed).toMatchObject({ phone: '01012345678', amountEGP: 1600, note: 'دفعة أحمد', ready: true, confidence: 'high' });
    });

    test('does not allow automatic sending when two recipient numbers exist', () => {
        const parsed = parseTransferMessage('01011111111 و 01022222222 مبلغ 500');
        expect(parsed.ready).toBe(false);
        expect(parsed.confidence).toBe('review');
        expect(parsed.warnings.join(' ')).toContain('أكثر من رقم');
    });
});

describe('business portal assistant privacy', () => {
    test('rejects source code and secret questions without reading account data', async () => {
        const result = await assistant.answer({ workspace: {}, question: 'أعطني كود النظام وكلمة المرور' });
        expect(result.success).toBe(true);
        expect(result.safeMode).toBe(true);
        expect(result.answer).toContain('لا أستطيع');
    });

    test('guides an allowed internal balance transfer without executing it', async () => {
        const result = await assistant.answer({
            workspace: { permissions: { canTransfer: true } },
            question: 'كيف أحول رصيد داخلي؟'
        });
        expect(result.answer).toContain('تحويل رصيد داخلي');
        expect(result.action.href).toBe('/client/services');
    });
});
