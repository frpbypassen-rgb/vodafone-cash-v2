'use strict';

jest.mock('axios', () => ({ post: jest.fn() }));

const axios = require('axios');
const whatsappService = require('../services/whatsappService');

const environmentKeys = [
    'WHATCHIMP_ENABLED',
    'WHATCHIMP_API_TOKEN',
    'WHATCHIMP_PHONE_NUMBER_ID',
    'WHATCHIMP_OTP_TEMPLATE',
    'WHATCHIMP_OTP_TEMPLATE_LANGUAGE',
    'WHATCHIMP_OTP_VARIABLE_ORDER',
    'WHATCHIMP_RECEIPT_MEDIA_TEMPLATE_ID',
    'WHATCHIMP_RECEIPT_TEMPLATE',
    'WHATCHIMP_RECEIPT_TEMPLATE_LANGUAGE',
    'WHATCHIMP_RECEIPT_VARIABLE_ORDER',
    'WHATCHIMP_API_BASE_URL'
];
const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));

const configureWhatChimp = () => {
    process.env.WHATCHIMP_ENABLED = 'true';
    process.env.WHATCHIMP_API_TOKEN = 'test-token';
    process.env.WHATCHIMP_PHONE_NUMBER_ID = 'phone-id-1';
    process.env.WHATCHIMP_OTP_TEMPLATE = 'power_pay_otp';
    process.env.WHATCHIMP_OTP_TEMPLATE_LANGUAGE = 'ar';
};

describe('WhatChimp WhatsApp service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        environmentKeys.forEach((key) => delete process.env[key]);
    });

    afterAll(() => {
        environmentKeys.forEach((key) => {
            if (originalEnvironment[key] === undefined) delete process.env[key];
            else process.env[key] = originalEnvironment[key];
        });
    });

    test('normalizes Egyptian and Libyan numbers for WhatsApp', () => {
        expect(whatsappService.normalizeWhatsAppPhone('01108172258')).toBe('201108172258');
        expect(whatsappService.normalizeWhatsAppPhone('0912345678')).toBe('218912345678');
        expect(whatsappService.normalizeWhatsAppPhone('0940719000')).toBe('218940719000');
        expect(whatsappService.normalizeWhatsAppPhone('+218 91 234 5678')).toBe('218912345678');
        expect(whatsappService.normalizeWhatsAppPhone('٠٩٤٠٧١٩٠٠٠')).toBe('218940719000');
    });

    test('sends OTP via approved WhatChimp template with the configured variable order', async () => {
        configureWhatChimp();
        process.env.WHATCHIMP_OTP_VARIABLE_ORDER = 'otp,expiresMinutes';
        axios.post.mockResolvedValue({ data: { status: '1', wa_message_id: 'wamid.otp.1' } });

        const result = await whatsappService.sendOtp({
            phone: '01108172258',
            otp: '483920',
            expiresMinutes: 5,
            accountName: 'عميل اختبار',
            accountType: 'العميل'
        });

        expect(result).toMatchObject({ success: true, provider: 'whatchimp', messageId: 'wamid.otp.1', phone: '201108172258' });
        expect(axios.post).toHaveBeenCalledWith(
            'https://app.whatchimp.com/api/v1/whatsapp/send',
            expect.stringContaining('template_name=power_pay_otp'),
            expect.objectContaining({ headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
        );
        const payload = axios.post.mock.calls[0][1];
        expect(payload).toContain('phone_number=201108172258');
        expect(payload).toContain('variable1=483920');
        expect(payload).toContain('variable2=5');
    });

    test('sends a free-text support reply through the WhatChimp session endpoint', async () => {
        configureWhatChimp();
        axios.post.mockResolvedValue({ data: { status: '1', wa_message_id: 'wamid.support.1' } });

        const result = await whatsappService.sendWhatChimpText({
            phone: '01108172258',
            message: 'Support reply'
        });

        expect(result).toMatchObject({ success: true, provider: 'whatchimp', messageId: 'wamid.support.1', phone: '201108172258' });
        expect(axios.post).toHaveBeenCalledWith(
            'https://app.whatchimp.com/api/v1/whatsapp/send',
            expect.stringContaining('message=Support+reply'),
            expect.any(Object)
        );
        const payload = axios.post.mock.calls[0][1];
        expect(payload).toContain('phone_number=201108172258');
        expect(payload).not.toContain('template_name=');
    });
    test('sends a receipt through the media-template endpoint', async () => {
        configureWhatChimp();
        process.env.WHATCHIMP_RECEIPT_MEDIA_TEMPLATE_ID = '44';
        axios.post.mockResolvedValue({ data: { status: '1', wa_message_id: 'wamid.receipt.1' } });

        const result = await whatsappService.sendReceipt({
            phone: '0912345678',
            receiptUrl: 'https://pay.example.test/public/receipt/abc/image?signature=signed'
        });

        expect(result).toMatchObject({ success: true, templateId: '44', phone: '218912345678' });
        expect(axios.post).toHaveBeenCalledWith(
            'https://app.whatchimp.com/api/v1/whatsapp/send/template',
            expect.stringContaining('template_header_media_url='),
            expect.any(Object)
        );
        expect(axios.post.mock.calls[0][1]).toContain('template_id=44');
    });

    test('reports missing configuration without making an external request', async () => {
        process.env.WHATCHIMP_ENABLED = 'true';

        const result = await whatsappService.sendOtp({ phone: '01108172258', otp: '123456' });

        expect(result).toMatchObject({ success: false, code: 'WHATCHIMP_CONFIG_MISSING' });
        expect(axios.post).not.toHaveBeenCalled();
    });

    test('uses the official JSON template-list request for a connection test', async () => {
        configureWhatChimp();
        axios.post.mockResolvedValue({ data: { status: '1', message: [] } });

        const result = await whatsappService.testWhatChimpConnection();

        expect(result).toMatchObject({ success: true, code: 'WHATCHIMP_CONNECTED', templates: [] });
        expect(axios.post).toHaveBeenCalledWith(
            'https://app.whatchimp.com/api/v1/whatsapp/template/list',
            { apiToken: 'test-token', phone_number_id: 'phone-id-1' },
            expect.objectContaining({ headers: { 'Content-Type': 'application/json' } })
        );
    });

    test('requires an approved receipt template before reporting receipts as operational', async () => {
        configureWhatChimp();
        process.env.WHATCHIMP_RECEIPT_MEDIA_TEMPLATE_ID = '422808';
        axios.post.mockResolvedValue({
            data: {
                status: '1',
                message: [{ id: 422808, template_name: 'power_pay_receipt', status: 'Pending' }]
            }
        });

        const pending = await whatsappService.getWhatChimpTemplateReadiness();

        expect(pending).toMatchObject({
            providerConnected: true,
            receiptOperational: false,
            receiptTemplate: { id: '422808', name: 'power_pay_receipt', status: 'Pending', approved: false }
        });

        axios.post.mockResolvedValue({
            data: {
                status: '1',
                message: [{ id: 422808, template_name: 'power_pay_receipt', status: 'Approved' }]
            }
        });

        const approved = await whatsappService.getWhatChimpTemplateReadiness();
        expect(approved.receiptOperational).toBe(true);
        expect(approved.receiptTemplate.approved).toBe(true);
    });
});
