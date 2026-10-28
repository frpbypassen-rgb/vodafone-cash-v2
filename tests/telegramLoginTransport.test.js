'use strict';
const express = require('express');
const request = require('supertest');
const transport = require('../services/telegramLoginTransport');
const service = require('../services/telegramLoginSecurityService');
const previous = {};
beforeEach(() => {
    for (const name of [
        'TELEGRAM_LOGIN_BOT_TOKEN',
        'TELEGRAM_LOGIN_BOT_USERNAME',
        'TELEGRAM_LOGIN_WEBHOOK_SECRET',
        'TELEGRAM_BOT_TOKEN',
    ]) {
        previous[name] = process.env[name];
        delete process.env[name];
    }
    process.env.TELEGRAM_LOGIN_BOT_TOKEN = '900001:' + 'x'.repeat(35);
    process.env.TELEGRAM_LOGIN_WEBHOOK_SECRET = 'test_only_telegram_webhook_secret_0123456789';
});
afterEach(() => {
    jest.restoreAllMocks();
    for (const [name, value] of Object.entries(previous))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
});
test('dedicated configuration and constant-time secret verification are required', () => {
    expect(transport.config().username).toBe('Ahram_otp_bot');
    expect(transport.configured()).toBe(true);
    expect(transport.verifySecret(process.env.TELEGRAM_LOGIN_WEBHOOK_SECRET)).toBe(true);
    expect(transport.verifySecret('wrong')).toBe(false);
    process.env.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_LOGIN_BOT_TOKEN;
    expect(transport.configured()).toBe(false);
});
test('transport failures never expose bot credentials or fall back to another channel', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(
        new Error('https://api.telegram.org/bot' + process.env.TELEGRAM_LOGIN_BOT_TOKEN)
    );
    await expect(transport.sendCode('112233', '123456')).rejects.toThrow('TELEGRAM_LOGIN_SEND_FAILED');
    try {
        await transport.sendCode('112233', '123456');
    } catch (error) {
        expect(error.message).not.toContain(process.env.TELEGRAM_LOGIN_BOT_TOKEN);
    }
    expect(() => transport.sendCode('-1001', '123456')).toThrow('INVALID_TELEGRAM_LOGIN_TARGET');
});
test('webhook ignores groups and unrelated commands and rejects unauthorized callers', async () => {
    const handler = jest.spyOn(service, 'handleStart').mockResolvedValue(true);
    const app = express();
    app.use(express.json());
    app.use('/webhooks/telegram-login', require('../routes/telegramLoginWebhook'));
    const body = {
        message: {
            text: '/start TL1' + 'A'.repeat(55),
            chat: { id: 112233, type: 'private' },
            from: { id: 112233 },
        },
    };
    await request(app).post('/webhooks/telegram-login').send(body).expect(401);
    const header = ['X-Telegram-Bot-Api-Secret-Token', process.env.TELEGRAM_LOGIN_WEBHOOK_SECRET];
    await request(app)
        .post('/webhooks/telegram-login')
        .set(...header)
        .send({ message: { ...body.message, chat: { id: -1001, type: 'group' } } })
        .expect(200);
    await request(app)
        .post('/webhooks/telegram-login')
        .set(...header)
        .send({ message: { ...body.message, text: '/start receipt-link' } })
        .expect(200);
    expect(handler).not.toHaveBeenCalled();
    await request(app)
        .post('/webhooks/telegram-login')
        .set(...header)
        .send(body)
        .expect(200);
    expect(handler).toHaveBeenCalledTimes(1);
});
