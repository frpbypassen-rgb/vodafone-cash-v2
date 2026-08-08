'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

jest.mock('../services/reportPdfService', () => ({
    findBrowserExecutable: jest.fn(),
    getSharedBrowser: jest.fn(),
    logoDataUri: jest.fn(() => ''),
    renderView: jest.fn()
}));

const {
    API_PATH,
    buildIntegrationDocumentData,
    resolvePublicApiOrigin
} = require('../services/accountIntegrationPdfService');

describe('Account integration PDF document data', () => {
    const account = {
        _id: '66a112233445566778899001',
        name: 'شركة الربط التجريبية',
        phone: '0912345678',
        accountCode: '12345',
        status: 'active',
        businessProfile: {
            contactName: 'أحمد مسؤول الربط',
            email: 'integration@example.test',
            city: 'طرابلس',
            address: 'حي الأعمال',
            registrationNumber: 'REG-2026-01'
        }
    };

    test('builds a company-specific document with exact API routes and no key in examples', () => {
        const documentData = buildIntegrationDocumentData({
            account,
            accountType: 'company',
            apiKey: 'company-private-key-123',
            apiOrigin: 'https://pay.example.test/',
            serviceRates: { vodafone: 5.95, post_account: 5.9 },
            generatedAt: new Date('2026-08-08T10:00:00.000Z')
        });

        expect(documentData.documentNumber).toBe('API-CO-12345-20260808');
        expect(documentData.account.apiKey).toBe('company-private-key-123');
        expect(documentData.api.basePath).toBe(`https://pay.example.test${API_PATH}`);
        expect(documentData.api.transferUrl).toBe(`https://pay.example.test${API_PATH}/transfer`);
        expect(documentData.api.statusUrl).toBe(`https://pay.example.test${API_PATH}/status/{invoice_number}`);
        expect(documentData.services).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'vodafone', rate: '5.95' }),
            expect.objectContaining({ key: 'post_account', rate: '5.90' })
        ]));
        expect(documentData.examples.transferCurl).toContain('x-api-key: <API_KEY>');
        expect(documentData.examples.transferCurl).not.toContain('company-private-key-123');
    });

    test('renders a complete Arabic document with the assigned key and account data', () => {
        const documentData = buildIntegrationDocumentData({
            account,
            accountType: 'company',
            apiKey: 'company-private-key-123',
            apiOrigin: 'https://pay.example.test',
            serviceRates: { vodafone: 5.95 },
            generatedAt: new Date('2026-08-08T10:00:00.000Z')
        });
        const template = fs.readFileSync(path.join(__dirname, '../views/account_integration_pdf.ejs'), 'utf8');
        const html = ejs.render(template, documentData);

        expect(html).toContain('وثيقة ربط واجهة API');
        expect(html).toContain('شركة الربط التجريبية');
        expect(html).toContain('company-private-key-123');
        expect(html).toContain('/api/v1/merchant/transfer');
        expect(html).toContain('واتساب فقط');
    });

    test('uses a configured public origin before forwarded request headers', () => {
        const previous = process.env.PUBLIC_APP_URL;
        process.env.PUBLIC_APP_URL = 'https://api.power-pay.example/';
        const request = {
            headers: { 'x-forwarded-proto': 'http' },
            protocol: 'http',
            get: jest.fn(() => '127.0.0.1:3002')
        };

        expect(resolvePublicApiOrigin(request)).toBe('https://api.power-pay.example');

        if (previous === undefined) delete process.env.PUBLIC_APP_URL;
        else process.env.PUBLIC_APP_URL = previous;
    });
});
