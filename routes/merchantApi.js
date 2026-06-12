const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const ClientBot = require('../models/ClientBot');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const Ledger = require('../models/Ledger');
const Counter = require('../models/Counter');

const isTransactionUnsupportedError = (error) => {
    const message = error && error.message ? error.message : '';
    return message.includes('replica set')
        || message.includes('Transaction numbers')
        || message.includes('mongos')
        || (message.includes('Transaction') && message.includes('not allowed'));
};

const merchantRequestError = (statusCode, message) => {
    const error = new Error(message);
    error.statusCode = statusCode;
    error.clientMessage = message;
    return error;
};

const withOptionalTransaction = async (work) => {
    let session;
    try {
        session = await mongoose.startSession();
        session.startTransaction();
        const result = await work(session);
        await session.commitTransaction();
        return result;
    } catch (error) {
        if (session) {
            try { await session.abortTransaction(); } catch (_) {}
        }
        if (isTransactionUnsupportedError(error)) {
            return work(null);
        }
        throw error;
    } finally {
        if (session) {
            session.endSession();
        }
    }
};

const merchantApiAuth = async (req, res, next) => {
    try {
        const apiKey = req.headers['x-api-key'];
        if (!apiKey) {
            return res.status(401).json({ status: 'failed', message: 'مفتاح المصادقة x-api-key مفقود' });
        }

        const company = await ClientBot.findOne({ token: apiKey, status: 'active' }).lean();
        if (!company) {
            return res.status(401).json({ status: 'failed', message: 'مفتاح المصادقة غير صحيح أو الحساب موقوف' });
        }

        req.merchant = company;
        return next();
    } catch (_error) {
        return res.status(500).json({ status: 'failed', message: 'حدث خطأ داخلي أثناء التحقق من التاجر' });
    }
};

router.get('/balance', merchantApiAuth, async (req, res) => {
    const settings = await Settings.findOne({}).lean();
    const globalRate = Number(settings && settings.exchangeRate ? settings.exchangeRate : 1);
    const customRate = Number(req.merchant.exchangeRate ? req.merchant.exchangeRate : globalRate);

    res.json({
        status: 'success',
        data: {
            merchant_name: req.merchant.name,
            balance: req.merchant.balance,
            exchange_rate: customRate
        }
    });
});

router.post('/transfer', merchantApiAuth, async (req, res) => {
    try {
        const { target_number, amount, transfer_type } = req.body;
        const amountValue = Number(amount);
        const phoneStr = target_number ? target_number.toString().trim() : '';

        if (!/^\d{11}$/.test(phoneStr)) {
            return res.status(400).json({ status: 'failed', message: 'رقم الهاتف غير صالح. يجب أن يتكون من 11 رقماً.' });
        }
        if (!Number.isFinite(amountValue) || amountValue <= 0) {
            return res.status(400).json({ status: 'failed', message: 'المبلغ غير صالح' });
        }

        const result = await withOptionalTransaction(async (session) => {
            const settingsQuery = Settings.findOne({});
            const settings = session ? await settingsQuery.session(session).lean() : await settingsQuery.lean();
            const globalRate = Number(settings && settings.exchangeRate ? settings.exchangeRate : 1);
            const exchangeRate = Number(req.merchant.exchangeRate ? req.merchant.exchangeRate : globalRate);
            if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
                throw merchantRequestError(400, 'سعر الصرف غير صالح');
            }

            const costLYD = Number((amountValue / exchangeRate).toFixed(3));
            const merchantUpdateOptions = { new: true };
            if (session) merchantUpdateOptions.session = session;

            const updatedMerchant = await ClientBot.findOneAndUpdate(
                { _id: req.merchant._id, status: 'active', balance: { $gte: costLYD } },
                { $inc: { balance: -costLYD } },
                merchantUpdateOptions
            );

            if (!updatedMerchant) {
                throw merchantRequestError(400, 'رصيد التاجر غير كافٍ لإتمام الطلب');
            }

            const now = new Date();
            const yy = now.getFullYear().toString().slice(-2);
            const mm = (now.getMonth() + 1).toString().padStart(2, '0');
            const counterOptions = { upsert: true, new: true };
            if (session) counterOptions.session = session;

            const counter = await Counter.findOneAndUpdate(
                { name: 'transaction' },
                { $inc: { value: 1 } },
                counterOptions
            );
            const customId = `ATT-${yy}${mm}-${counter.value.toString().padStart(4, '0')}`;

            const txData = {
                userId: 'api_merchant',
                companyId: req.merchant._id,
                amount: amountValue,
                costLYD,
                exchangeRate,
                vodafoneNumber: phoneStr,
                status: 'pending',
                customId,
                companyName: req.merchant.name,
                employeeName: 'ربط آلي (Merchant API)',
                transferType: transfer_type || 'vodafone',
                notes: '[طلب وارد عبر API التاجر الخارجي]',
                executorGroupId: (settings && settings.autoRouteEnabled && settings.autoRouteBotId) ? settings.autoRouteBotId : undefined
            };
            const tx = session
                ? (await Transaction.create([txData], { session }))[0]
                : await Transaction.create(txData);

            const balanceAfter = Number(updatedMerchant.balance || 0);
            const ledgerEntry = new Ledger({
                entityId: req.merchant._id,
                entityModel: 'ClientCompany',
                transactionId: customId,
                type: 'TRANSFER',
                amount: -costLYD,
                balanceBefore: balanceAfter + costLYD,
                balanceAfter,
                description: `Merchant API transfer ${customId}`
            });
            if (session) {
                await ledgerEntry.save({ session });
            } else {
                await ledgerEntry.save();
            }

            return { tx, exchangeRate, balanceAfter };
        });

        return res.json({
            status: 'success',
            message: 'تم استلام الطلب بنجاح وهو الآن قيد المعالجة',
            data: {
                transaction_id: result.tx._id,
                invoice_number: result.tx.customId,
                status: 'pending',
                amount_egp: result.tx.amount,
                exchange_rate: result.exchangeRate,
                cost_lyd: result.tx.costLYD,
                balance: result.balanceAfter
            }
        });
    } catch (error) {
        if (error && error.statusCode) {
            return res.status(error.statusCode).json({
                status: 'failed',
                message: error.clientMessage || error.message
            });
        }
        return res.status(500).json({ status: 'failed', message: 'حدث خطأ داخلي أثناء معالجة الطلب' });
    }
});

router.get('/status/:reference_id', merchantApiAuth, async (req, res) => {
    try {
        const tx = await Transaction.findOne({ companyId: req.merchant._id, customId: req.params.reference_id }).lean();
        if (!tx) {
            return res.status(404).json({ status: 'failed', message: 'لا يوجد طلب بهذا الرقم المرجعي' });
        }

        res.json({
            status: 'success',
            data: {
                transaction_id: tx._id,
                reference_id: tx.customId,
                target_number: tx.vodafoneNumber,
                amount_egp: tx.amount,
                exchange_rate: tx.exchangeRate || 1,
                cost_lyd: tx.costLYD || tx.amount,
                status: tx.status,
                notes: tx.notes || 'لا يوجد ملاحظات'
            }
        });
    } catch (_error) {
        res.status(500).json({ status: 'failed', message: 'خطأ داخلي' });
    }
});

module.exports = router;
