'use strict';
const router = require('express').Router();
const transport = require('../services/telegramLoginTransport');
router.post('/', async (req, res) => {
    if (!transport.configured()) return res.sendStatus(503);
    if (!transport.verifySecret(req.get('X-Telegram-Bot-Api-Secret-Token'))) return res.sendStatus(401);
    const message = req.body?.message;
    if (
        message?.chat?.type !== 'private' ||
        !/^\/start(?:@[A-Za-z0-9_]+)?\s+TL1[A-Za-z0-9_-]{55}$/.test(String(message?.text || '').trim())
    )
        return res.sendStatus(200);
    const token = message.text.trim().split(/\s+/)[1];
    try {
        await require('../services/telegramLoginSecurityService').handleStart({
            token,
            chatId: message.chat.id,
            userId: message.from?.id,
            username: message.from?.username,
        });
    } catch (_) {
        /* A failed attempt cannot create a verified link. Never log bot tokens or update bodies. */
    }
    return res.sendStatus(200);
});
module.exports = router;
