'use strict';
const express = require('express');
const crypto = require('crypto');
const ExecutorGroup = require('../models/ExecutorGroup');
const Transaction = require('../models/Transaction');
const Event = require('../models/KenanWebhookEvent');
const { parseOrder } = require('../services/kenanProviderService');
const router = express.Router();
router.post('/:executorId', express.raw({ type: 'application/json', limit: '64kb', inflate: false }), async (req, res) => {
    if (!/^[a-f0-9]{24}$/i.test(req.params.executorId) || !Buffer.isBuffer(req.body)) return res.sendStatus(400);
    try {
        const bot = await ExecutorGroup.findOne({ _id: req.params.executorId, apiProviderKey: 'kenan', isApiBot: true }).select('+kenanWebhookSecret');
        if (!bot?.kenanWebhookSecret) return res.sendStatus(401);
        const signature = String(req.get('X-Kenan-Signature') || '');
        const expected = crypto.createHmac('sha256', bot.kenanWebhookSecret).update(req.body).digest();
        if (!/^[a-f0-9]{64}$/i.test(signature) || !crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return res.sendStatus(401);
        let order;
        try { order = parseOrder(JSON.parse(req.body.toString('utf8'))); } catch (_) { return res.sendStatus(400); }
        const digest = crypto.createHash('sha256').update(req.body).digest('hex');
        const eventId = `${bot._id}:${digest}`;
        // Persist before acknowledging. Repeated and out-of-order callbacks never
        // post money or overwrite terminal state; GET remains authoritative.
        try {
            await Event.updateOne({ _id: eventId }, { $setOnInsert: { executorGroupId: bot._id, digest, reference: order.reference, order, receivedAt: new Date() } }, { upsert: true, writeConcern: { w: 'majority' } });
        } catch (error) { if (error.code !== 11000) throw error; }
        await Transaction.updateOne({ executorGroupId: bot._id, status: 'processing',
            'apiResultData.kenanReference': order.reference, 'apiResultData.kenanAwaitingStatus': true,
            'apiResultData.providerResolutionOutcome': { $exists: false } },
        { $set: { 'apiResultData.kenanNextPollAt': new Date(0) } }, { writeConcern: { w: 'majority' } });
        return res.sendStatus(204);
    } catch (_) { return res.sendStatus(503); }
});
module.exports = router;
