'use strict';
const crypto = require('crypto');
const error = (code, message, statusCode = 409) =>
    Object.assign(new Error(message), { code, statusCode });
const prepare = (merchant, key, payload) => {
    if (key === undefined) return null;
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(key))
        throw error(
            'IDEMPOTENCY_KEY_INVALID',
            'أرسل Idempotency-Key بطول 1 إلى 128 حرفًا إنجليزيًا أو رقمًا أو . _ : -',
            400,
        );
    const binding = {
        accountId: String(merchant._id),
        tenantId: merchant.tenantId || null,
        channel: 'merchant-api:' + merchant.entityModel,
        payload,
    };
    return {
        key:
            'merchant-api:' +
            crypto
                .createHash('sha256')
                .update(
                    JSON.stringify([
                        binding.channel,
                        binding.accountId,
                        String(binding.tenantId || ''),
                        key,
                    ]),
                )
                .digest('hex'),
        fingerprint: require('./financialSafety').boundFingerprint(binding),
    };
};
const lookup = async (state) => {
    if (!state) return null;
    const existing = await require('../models/Transaction')
        .findOne({ idempotencyKey: state.key })
        .select('idempotencyFingerprint idempotencyResponse')
        .lean();
    if (!existing) return null;
    if (existing.idempotencyFingerprint !== state.fingerprint)
        throw error(
            'IDEMPOTENCY_CONFLICT',
            'استُخدم هذا المفتاح لطلب مختلف. لا تغيّر بيانات الطلب عند إعادة المحاولة.',
        );
    if (!existing.idempotencyResponse)
        throw error(
            'IDEMPOTENCY_IN_PROGRESS',
            'الطلب قيد التحقق. أعد الاستعلام أو المحاولة بالمفتاح نفسه.',
        );
    return existing.idempotencyResponse;
};
const persist = async (state, tx, response, session) => {
    if (!state) return;
    if (!session)
        throw error(
            'FINANCIAL_TRANSACTIONS_UNAVAILABLE',
            'يلزم اتصال MongoDB يدعم المعاملات لحماية هذا الطلب.',
            503,
        );
    const result = await require('../models/Transaction').updateOne(
        {
            _id: tx._id,
            idempotencyKey: state.key,
            idempotencyFingerprint: state.fingerprint,
        },
        { $set: { idempotencyResponse: response } },
        { session },
    );
    if (result.matchedCount !== 1)
        throw error(
            'IDEMPOTENCY_STORE_FAILED',
            'تعذر حفظ نتيجة الطلب بأمان.',
            503,
        );
};
const concurrent = (err) =>
    [11000, 112, 244, 251].includes(err?.code) ||
    err?.hasErrorLabel?.('TransientTransactionError') ||
    err?.hasErrorLabel?.('UnknownTransactionCommitResult');
module.exports = { prepare, lookup, persist, concurrent, error };
