'use strict';

const receiptShareService = require('../services/receiptShareService');

const environmentKeys = ['PUBLIC_APP_URL', 'RECEIPT_SHARE_SECRET', 'WHATCHIMP_RECEIPT_URL_TTL_HOURS'];
const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));

describe('Receipt share links', () => {
    beforeEach(() => {
        process.env.PUBLIC_APP_URL = 'https://pay.example.test';
        process.env.RECEIPT_SHARE_SECRET = 'receipt-test-secret';
        process.env.WHATCHIMP_RECEIPT_URL_TTL_HOURS = '24';
    });

    afterAll(() => {
        environmentKeys.forEach((key) => {
            if (originalEnvironment[key] === undefined) delete process.env[key];
            else process.env[key] = originalEnvironment[key];
        });
    });

    test('creates a verifiable signed image URL', () => {
        const expiresAt = Date.now() + (60 * 60 * 1000);
        const url = receiptShareService.createReceiptImageUrl({
            transactionId: '6a762a409354c789c70fc193',
            index: 0,
            expiresAt
        });
        const parsed = new URL(url);

        expect(parsed.pathname).toBe('/public/receipt/6a762a409354c789c70fc193/image');
        expect(receiptShareService.verifyReceiptAccess({
            transactionId: '6a762a409354c789c70fc193',
            index: 0,
            expires: parsed.searchParams.get('expires'),
            signature: parsed.searchParams.get('signature')
        })).toBe(true);
    });

    test('rejects a signature that does not match the receipt index', () => {
        const url = receiptShareService.createReceiptImageUrl({
            transactionId: '6a762a409354c789c70fc193',
            index: 0,
            expiresAt: Date.now() + (60 * 60 * 1000)
        });
        const parsed = new URL(url);

        expect(receiptShareService.verifyReceiptAccess({
            transactionId: '6a762a409354c789c70fc193',
            index: 1,
            expires: parsed.searchParams.get('expires'),
            signature: parsed.searchParams.get('signature')
        })).toBe(false);
    });
});
