'use strict';

const crypto = require('crypto');
const {
    buildPayload,
    normalizeEvents,
    signPayload,
    validateWebhookUrl
} = require('../services/merchantWebhookService');

describe('merchant webhook service', () => {
    test('signs the timestamp and exact JSON body with HMAC SHA-256', () => {
        const expected = crypto.createHmac('sha256', 'secret').update('1700000000.{"ok":true}').digest('hex');
        expect(signPayload('secret', '1700000000', '{"ok":true}')).toBe(expected);
    });

    test('normalizes supported events and rejects an empty subscription', () => {
        expect(normalizeEvents(['transfer.created', 'transfer.created', 'unknown'])).toEqual(['transfer.created']);
        expect(() => normalizeEvents(['unknown'])).toThrow('WEBHOOK_EVENTS_REQUIRED');
    });

    test('rejects insecure and private webhook targets before delivery', async () => {
        await expect(validateWebhookUrl('http://example.com/hook')).rejects.toThrow('WEBHOOK_HTTPS_REQUIRED');
        await expect(validateWebhookUrl('https://127.0.0.1/hook')).rejects.toThrow('WEBHOOK_PRIVATE_ADDRESS');
        await expect(validateWebhookUrl('https://localhost/hook')).rejects.toThrow('WEBHOOK_PRIVATE_ADDRESS');
    });

    test('builds a stable public transaction payload without executor credentials', () => {
        const payload = buildPayload('transfer.completed', {
            _id: 'tx-1', customId: 'ATT-001', status: 'completed', transferType: 'vodafone',
            amount: 1000, costLYD: 150, exchangeRate: 6.67, apiToken: 'must-not-leak'
        });
        expect(payload.type).toBe('transfer.completed');
        expect(payload.data).toMatchObject({ reference: 'ATT-001', amount: 1000, cost_lyd: 150 });
        expect(JSON.stringify(payload)).not.toContain('must-not-leak');
    });
});
