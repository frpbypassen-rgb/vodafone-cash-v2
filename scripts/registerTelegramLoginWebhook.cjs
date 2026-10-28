'use strict';
require('dotenv').config({ quiet: true });
const transport = require('../services/telegramLoginTransport');
const main = async () => {
    const settings = transport.config();
    if (!settings.ready)
        throw new Error(
            'Configure the dedicated TELEGRAM_LOGIN_BOT_TOKEN, username and webhook secret first.'
        );
    const base = new URL(String(process.env.PUBLIC_APP_URL || ''));
    if (base.protocol !== 'https:' || base.username || base.password)
        throw new Error('PUBLIC_APP_URL must be a public HTTPS origin.');
    const url = new URL('/webhooks/telegram-login', base.origin).href;
    if (!process.argv.includes('--apply')) {
        console.log(
            JSON.stringify({ configured: true, bot: settings.username, webhook: url, applied: false })
        );
        return;
    }
    const bot = await transport.request('getMe', {});
    if (
        !bot.is_bot ||
        String(bot.id) !== settings.botId ||
        String(bot.username).toLowerCase() !== settings.username.toLowerCase()
    )
        throw new Error('The token does not belong to the configured OTP bot.');
    await transport.request('setWebhook', {
        url,
        secret_token: settings.secret,
        allowed_updates: ['message'],
        drop_pending_updates: false,
    });
    console.log(JSON.stringify({ applied: true, bot: settings.username, webhook: url }));
};
main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
