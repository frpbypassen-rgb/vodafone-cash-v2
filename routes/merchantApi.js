const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const ClientBot = require('../models/ClientBot');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Settings = require('../models/Settings');
const Ledger = require('../models/Ledger');
const Counter = require('../models/Counter');
const {
    getCompanyServiceRates,
    resolveTransferServiceKey
} = require('../utils/rateHelper');
const {
    resolveAutoRouteExecutor,
    applyAutoRouteFields,
    enqueueAutoRouteIfNeeded
} = require('../services/autoRouteService');
const {
    acquireTransferCooldown,
    releaseTransferCooldown
} = require('../services/transferCooldownService');

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

const customerFacingNotes = (notes) => {
    const raw = String(notes || '').trim();
    if (!raw) return '';
    const beforeApiLog = raw.split(/---\s*سجل\s+الـ\s+API/i)[0].trim();
    const legacyTransferMatch = beforeApiLog.match(/(?:تحويل رصيد صادر إلى|تحويل رصيد وارد من).*\|\s*(.+)$/);
    if (legacyTransferMatch) return legacyTransferMatch[1].trim();
    const systemPatterns = [
        /^سبب الرفض:/,
        /^\[تم /,
        /^\[فشل /,
        /^\[معلقة /,
        /^\[رقم الإلغاء:/,
        /^تحويل رصيد صادر إلى/,
        /^تحويل رصيد وارد من/,
        /^تمويل نقطة بيع/,
        /^سحب رصيد من نقطة بيع/,
        /^\[طلب وارد عبر API/
    ];
    return beforeApiLog.split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => /رقم المحول|رقم المرسل|الرقم المرجعي|مرجع|reference|ref/i.test(line) || !systemPatterns.some((pattern) => pattern.test(line)))
        .join('\n')
        .trim();
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
        if (company) {
            req.merchant = {
                ...company,
                merchantType: 'company',
                entityModel: 'ClientCompany',
                transactionUserId: 'api_merchant'
            };
            return next();
        }

        const agent = await User.findOne({
            apiToken: apiKey,
            role: 'agent',
            status: 'active'
        }).lean();
        if (!agent) {
            return res.status(401).json({ status: 'failed', message: 'مفتاح المصادقة غير صحيح أو الحساب موقوف' });
        }

        req.merchant = {
            ...agent,
            merchantType: 'agent',
            entityModel: 'User',
            transactionUserId: agent.phone || agent.webUsername || String(agent._id)
        };
        return next();
    } catch (_error) {
        return res.status(500).json({ status: 'failed', message: 'حدث خطأ داخلي أثناء التحقق من التاجر' });
    }
};

router.get('/balance', merchantApiAuth, async (req, res) => {
    const settings = await Settings.findOne({}).lean();
    const customRate = getCompanyServiceRates(req.merchant, settings).vodafone;

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
    let cooldownLock = null;
    try {
        const { target_number, amount, transfer_type } = req.body;
        const amountValue = Number(amount);
        const phoneStr = target_number ? target_number.toString().trim() : '';
        const serviceKey = resolveTransferServiceKey(transfer_type || 'vodafone');

        if (!/^\d{11}$/.test(phoneStr)) {
            return res.status(400).json({ status: 'failed', message: 'رقم الهاتف غير صالح. يجب أن يتكون من 11 رقماً.' });
        }
        if (!Number.isFinite(amountValue) || amountValue <= 0) {
            return res.status(400).json({ status: 'failed', message: 'المبلغ غير صالح' });
        }

        if (!serviceKey) {
            return res.status(400).json({ status: 'failed', message: 'نوع التحويل غير مدعوم' });
        }

        const cooldown = await acquireTransferCooldown({
            ownerModel: req.merchant.entityModel,
            ownerId: req.merchant._id,
            serviceKey,
            recipient: phoneStr,
            amount: amountValue
        });
        cooldownLock = cooldown.lock;

        const result = await withOptionalTransaction(async (session) => {
            const settingsQuery = Settings.findOne({});
            const settings = session ? await settingsQuery.session(session).lean() : await settingsQuery.lean();
            const autoRouteExecutor = await resolveAutoRouteExecutor(settings, serviceKey, session);
            const exchangeRate = getCompanyServiceRates(req.merchant, settings)[serviceKey];
            if (!Number.isFinite(exchangeRate) || exchangeRate <= 0) {
                throw merchantRequestError(400, 'سعر الصرف غير صالح');
            }

            const costLYD = Number((amountValue / exchangeRate).toFixed(3));
            const merchantUpdateOptions = { new: true };
            if (session) merchantUpdateOptions.session = session;

            const isAgentMerchant = req.merchant.merchantType === 'agent';
            const MerchantModel = isAgentMerchant ? User : ClientBot;
            const minBalance = Number((costLYD - Math.max(0, Number(req.merchant.creditLimit) || 0)).toFixed(3));
            const merchantQuery = {
                _id: req.merchant._id,
                status: 'active',
                balance: { $gte: minBalance }
            };
            if (isAgentMerchant) merchantQuery.role = 'agent';

            const updatedMerchant = await MerchantModel.findOneAndUpdate(
                merchantQuery,
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
                userId: req.merchant.transactionUserId,
                companyId: isAgentMerchant ? undefined : req.merchant._id,
                amount: amountValue,
                costLYD,
                exchangeRate,
                vodafoneNumber: phoneStr,
                status: 'pending',
                customId,
                companyName: req.merchant.name,
                employeeName: 'ربط آلي (Merchant API)',
                transferType: serviceKey,
                ...cooldown.guardFields,
                notes: '',
                adminNotes: '[طلب وارد عبر API التاجر الخارجي]',
                executorGroupId: undefined
            };
            if (autoRouteExecutor) applyAutoRouteFields(txData, autoRouteExecutor);
            const tx = session
                ? (await Transaction.create([txData], { session }))[0]
                : await Transaction.create(txData);

            const balanceAfter = Number(updatedMerchant.balance || 0);
            const ledgerEntry = new Ledger({
                entityId: req.merchant._id,
                entityModel: req.merchant.entityModel,
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

            return { tx, exchangeRate, balanceAfter, autoRouteExecutor };
        });

        if (result.autoRouteExecutor) {
            enqueueAutoRouteIfNeeded(result.tx, result.autoRouteExecutor).catch((err) => {
                console.error('[Merchant API] Auto-route enqueue failed:', err.message);
            });
        }

        return res.json({
            status: 'success',
            message: 'تم استلام الطلب بنجاح وهو الآن قيد المعالجة',
            data: {
                transaction_id: result.tx._id,
                invoice_number: result.tx.customId,
                status: result.tx.status,
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
                code: error.code,
                message: error.clientMessage || error.message,
                cooldown_type: error.cooldownType,
                retry_after_seconds: error.retryAfterSeconds,
                retry_at: error.retryAt
            });
        }
        return res.status(500).json({ status: 'failed', message: 'حدث خطأ داخلي أثناء معالجة الطلب' });
    } finally {
        await releaseTransferCooldown(cooldownLock);
    }
});

router.get('/status/:reference_id', merchantApiAuth, async (req, res) => {
    try {
        const ownershipFilter = req.merchant.merchantType === 'agent'
            ? {
                userId: req.merchant.transactionUserId,
                companyId: null,
                isSubAccountTx: { $ne: true }
            }
            : { companyId: req.merchant._id };
        const tx = await Transaction.findOne({
            ...ownershipFilter,
            customId: req.params.reference_id
        }).lean();
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
                notes: customerFacingNotes(tx.notes) || 'لا يوجد ملاحظات'
            }
        });
    } catch (_error) {
        res.status(500).json({ status: 'failed', message: 'خطأ داخلي' });
    }
});

module.exports = router;
