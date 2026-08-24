'use strict';

const express = require('express');
const Transaction = require('../models/Transaction');
const { getClientReceiptProofIds } = require('../services/clientReceiptService');
const { proofSourceUrl, streamProofImage } = require('../services/proofStorageService');
const { verifyReceiptAccess } = require('../services/receiptShareService');

const router = express.Router();

router.get('/receipt/:transactionId/image', async (req, res) => {
    const index = Number.parseInt(req.query.index, 10);
    if (!verifyReceiptAccess({
        transactionId: req.params.transactionId,
        index,
        expires: req.query.expires,
        signature: req.query.signature
    })) {
        return res.status(403).send('رابط الإيصال غير صالح أو منتهي الصلاحية.');
    }

    try {
        const transaction = await Transaction.findById(req.params.transactionId).lean();
        if (!transaction || ![
            'completed',
            'cancelled',
            'canceled',
            'cancelled_by_admin',
            'rejected',
            'failed'
        ].includes(transaction.status)) {
            return res.status(404).send('الإيصال غير متاح.');
        }

        const photoId = getClientReceiptProofIds(transaction)[index];
        if (!photoId) return res.status(404).send('صورة الإيصال غير متاحة.');

        res.setHeader('X-Robots-Tag', 'noindex, noarchive, nosnippet');
        res.setHeader('Content-Disposition', 'inline; filename="receipt.jpg"');
        await streamProofImage(proofSourceUrl(photoId), res);
    } catch (error) {
        console.error('[Public Receipt] failed:', error.message);
        res.status(500).send('تعذر تحميل الإيصال.');
    }
});

module.exports = router;
