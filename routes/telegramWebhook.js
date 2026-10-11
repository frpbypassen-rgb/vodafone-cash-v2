'use strict';

const express = require('express');
const router = express.Router();
const { linkChatByCode, sendMessage } = require('../services/telegramService');

router.post('/', async (req, res) => {
    const expected = String(process.env.TELEGRAM_WEBHOOK_SECRET || '');
    const received = String(req.get('X-Telegram-Bot-Api-Secret-Token') || '');
    if (!expected) return res.sendStatus(503);
    const expectedBuffer = Buffer.from(expected);
    const receivedBuffer = Buffer.from(received);
    if (expectedBuffer.length !== receivedBuffer.length || !require('crypto').timingSafeEqual(expectedBuffer, receivedBuffer)) return res.sendStatus(401);
    const message = req.body?.message;
    const text = String(message?.text || '').trim();
    const chatId = message?.chat?.id;
    if (!chatId || !text) return res.sendStatus(200);
    try {
        const result = await linkChatByCode({ code: text, chatId });
        await sendMessage(chatId, result.success
            ? 'تم ربط حسابك بنجاح. ستصل إيصالاتك إلى هذه المحادثة.'
            : 'الكود غير صحيح أو منتهي. اطلب كوداً جديداً من الإدارة.');
    } catch (_) {
        await sendMessage(chatId, 'تعذر إتمام الربط حالياً، حاول لاحقاً.').catch(() => {});
    }
    return res.sendStatus(200);
});

module.exports = router;
