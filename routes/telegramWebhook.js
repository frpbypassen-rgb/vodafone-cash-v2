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
        const message = result.success
            ? 'تم ربط حسابك بنجاح. ستصل إيصالات الحساب إلى هذه المحادثة.'
            : result.code === 'CODE_ALREADY_USED'
                ? 'هذا الكود مستخدم بالفعل على جهاز آخر. إذا كنت صاحب الحساب وتعتقد أن هناك مشكلة، تواصل مع الدعم الفني أو اطلب من الإدارة إصدار كود جديد.'
                : 'تعذر التعرف على الكود. تأكد من كتابته كما أرسله لك مسؤول الحساب، أو اطلب كوداً جديداً من الإدارة.';
        await sendMessage(chatId, message);
    } catch (_) {
        await sendMessage(chatId, 'تعذر إتمام الربط حالياً، حاول لاحقاً.').catch(() => {});
    }
    return res.sendStatus(200);
});

module.exports = router;
