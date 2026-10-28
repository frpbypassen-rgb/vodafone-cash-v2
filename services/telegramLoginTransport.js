'use strict';
const crypto = require('node:crypto');
const config = () => {
    const token = String(process.env.TELEGRAM_LOGIN_BOT_TOKEN || '').trim();
    const username = String(process.env.TELEGRAM_LOGIN_BOT_USERNAME || 'Ahram_otp_bot')
        .trim()
        .replace(/^@/, '');
    const secret = String(process.env.TELEGRAM_LOGIN_WEBHOOK_SECRET || '').trim();
    const botId = /^\d+:[A-Za-z0-9_-]{20,}$/.test(token) ? token.split(':')[0] : '';
    const receiptBotId = String(process.env.TELEGRAM_BOT_TOKEN || '').split(':')[0];
    return {
        token,
        username,
        secret,
        botId,
        ready: Boolean(
            botId &&
            botId !== receiptBotId &&
            /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username) &&
            /^[A-Za-z0-9_-]{32,256}$/.test(secret)
        ),
    };
};
const configured = () => config().ready;
const request = async (method, body) => {
    const settings = config();
    if (!settings.ready) throw new Error('TELEGRAM_LOGIN_NOT_CONFIGURED');
    try {
        const response = await fetch(`https://api.telegram.org/bot${settings.token}/${method}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(15000),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok) throw new Error('REJECTED');
        return result.result;
    } catch (_) {
        throw new Error('TELEGRAM_LOGIN_SEND_FAILED');
    }
};
const sendCode = (chatId, code, purpose = 'login') => {
    if (!/^[1-9]\d{0,18}$/.test(String(chatId)) || !/^\d{6}$/.test(String(code)))
        throw new Error('INVALID_TELEGRAM_LOGIN_TARGET');
    const title =
        purpose === 'enrollment'
            ? 'تأكيد ربط تليجرام بأمان الحساب'
            : purpose === 'channel'
              ? 'تأكيد تغيير قناة أكواد الدخول'
              : 'رمز تسجيل الدخول';
    return request('sendMessage', {
        chat_id: String(chatId),
        text: `أهرام باي\n${title}\n\n${code}\n\nصالح لمدة 5 دقائق. لا تشارك الرمز مع أي شخص.\n${purpose === 'enrollment' ? 'أدخل الرمز في الموقع لإكمال الربط. لن تصلك أكواد الدخول قبل التأكيد واختيار تليجرام.' : 'إذا لم تطلب هذا الرمز، تجاهل الرسالة وراجع أمان حسابك.'}`,
    });
};
const verifySecret = (received) => {
    const expected = config().secret;
    return (
        configured() &&
        Buffer.byteLength(String(received || '')) === Buffer.byteLength(expected) &&
        crypto.timingSafeEqual(Buffer.from(String(received || '')), Buffer.from(expected))
    );
};
module.exports = { config, configured, request, sendCode, verifySecret };
