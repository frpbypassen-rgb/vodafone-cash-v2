'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const PointOfSaleCustomer = require('../models/PointOfSaleCustomer');
const PointOfSaleSettlement = require('../models/PointOfSaleSettlement');
const Ledger = require('../models/Ledger');
const { requiresMongoTransactions, isMongoTransactionFallbackError, financialTransactionsUnavailableError } = require('./walletService');

const money = (value) => Number(Number(value).toFixed(3));

const serviceError = (code, message, statusCode = 400) => {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
};

const settlementFingerprint = ({ customerId, externalCustomerId, type, amount }) => crypto
    .createHash('sha256')
    .update(JSON.stringify({ customerId: String(customerId), externalCustomerId, type, amount }))
    .digest('hex');

const newReference = () => `POSSET-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

const withFinancialSession = async (work) => {
    let session;
    try {
        session = await mongoose.startSession();
        session.startTransaction();
        const result = await work(session);
        await session.commitTransaction();
        return result;
    } catch (error) {
        if (session) await session.abortTransaction().catch(() => undefined);
        if (isMongoTransactionFallbackError(error) && requiresMongoTransactions()) {
            throw financialTransactionsUnavailableError(error);
        }
        throw error;
    } finally {
        if (session) session.endSession();
    }
};

const getOwnedCustomer = (ownerAgentId, customerId, session) => PointOfSaleCustomer.findOne({
    _id: customerId,
    ownerAgentId,
    status: 'active'
}).session(session);

const requestSettlement = async ({ ownerAgentId, tenantId, customerId, externalCustomerId, type, amount, idempotencyKey, actor = 'POS API' }) => {
    const normalizedType = String(type || '').trim().toLowerCase();
    const normalizedExternalId = String(externalCustomerId || '').trim();
    const normalizedKey = String(idempotencyKey || '').trim();
    if (!['full', 'partial'].includes(normalizedType)) throw serviceError('INVALID_SETTLEMENT_TYPE', 'نوع التسوية يجب أن يكون full أو partial.');
    if (!normalizedExternalId) throw serviceError('EXTERNAL_CUSTOMER_NOT_LINKED', 'يلزم تحديد معرف العميل في المنظومة الخارجية.');
    if (!normalizedKey) throw serviceError('IDEMPOTENCY_KEY_REQUIRED', 'يلزم مفتاح منع التكرار Idempotency-Key.');

    return withFinancialSession(async (session) => {
        const existing = await PointOfSaleSettlement.findOne({ ownerAgentId, idempotencyKey: normalizedKey }).session(session);
        if (existing) return { settlement: existing, replayed: true };

        const customer = await getOwnedCustomer(ownerAgentId, customerId, session);
        if (!customer) throw serviceError('POS_CUSTOMER_NOT_FOUND', 'العميل غير موجود أو موقوف.', 404);
        if (String(customer.externalLink?.externalCustomerId || '') !== normalizedExternalId) {
            throw serviceError('EXTERNAL_CUSTOMER_LINK_MISMATCH', 'معرف العميل الخارجي لا يطابق الربط المعتمد.');
        }

        const available = money(Number(customer.balance || 0) - Number(customer.reservedBalance || 0));
        const requested = normalizedType === 'full' ? available : money(amount);
        if (!Number.isFinite(requested) || requested <= 0) throw serviceError('SETTLEMENT_AMOUNT_INVALID', 'لا يوجد رصيد متاح للتسوية.');
        if (requested > available) throw serviceError('SETTLEMENT_AMOUNT_EXCEEDS_AVAILABLE', 'المبلغ المطلوب أكبر من الرصيد المتاح.');

        const fingerprint = settlementFingerprint({ customerId, externalCustomerId: normalizedExternalId, type: normalizedType, amount: requested });
        const reserved = await PointOfSaleCustomer.findOneAndUpdate(
            {
                _id: customer._id,
                ownerAgentId,
                status: 'active',
                $expr: { $gte: [{ $subtract: ['$balance', '$reservedBalance'] }, requested] }
            },
            { $inc: { reservedBalance: requested } },
            { new: true, session }
        );
        if (!reserved) throw serviceError('SETTLEMENT_CONCURRENT_REQUEST', 'تغير الرصيد أثناء التسوية. أعد المحاولة.', 409);

        const settlement = await PointOfSaleSettlement.create([{
            reference: newReference(), ownerAgentId, tenantId, customerId: customer._id,
            externalCustomerId: normalizedExternalId, amount: requested, type: normalizedType,
            idempotencyKey: normalizedKey, idempotencyFingerprint: fingerprint,
            balanceBefore: customer.balance,
            trace: [{ event: 'reserved', actor, details: { amount: requested, availableBefore: available } }]
        }], { session });
        return { settlement: settlement[0], replayed: false };
    });
};

const confirmSettlement = async ({ ownerAgentId, reference, externalReference, actor = 'External system' }) => withFinancialSession(async (session) => {
    const settlement = await PointOfSaleSettlement.findOne({ ownerAgentId, reference }).session(session);
    if (!settlement) throw serviceError('SETTLEMENT_NOT_FOUND', 'التسوية غير موجودة.', 404);
    if (settlement.status === 'completed') return { settlement, replayed: true };
    if (settlement.status !== 'awaiting_external_confirmation') throw serviceError('SETTLEMENT_NOT_CONFIRMABLE', 'لا يمكن تأكيد هذه التسوية بحالتها الحالية.', 409);

    const customer = await getOwnedCustomer(ownerAgentId, settlement.customerId, session);
    if (!customer || Number(customer.reservedBalance || 0) < settlement.amount || Number(customer.balance || 0) < settlement.amount) {
        throw serviceError('SETTLEMENT_RESERVATION_MISSING', 'حجز رصيد التسوية غير صالح.', 409);
    }
    customer.balance = money(customer.balance - settlement.amount);
    customer.reservedBalance = money(customer.reservedBalance - settlement.amount);
    await customer.save({ session });

    settlement.status = 'completed';
    settlement.externalReference = String(externalReference || '').trim().slice(0, 160);
    settlement.balanceAfter = customer.balance;
    settlement.reservedAfter = customer.reservedBalance;
    settlement.trace.push({ event: 'external_confirmation_received', actor, details: { externalReference: settlement.externalReference } });
    await settlement.save({ session });
    await new Ledger({
        entityId: customer._id, entityModel: 'PointOfSaleCustomer', transactionId: settlement.reference,
        type: 'DEDUCTION', amount: -settlement.amount,
        balanceBefore: money(customer.balance + settlement.amount), balanceAfter: customer.balance,
        description: `POS customer external settlement ${settlement.reference}`, tenantId: settlement.tenantId || undefined
    }).save({ session });
    return { settlement, replayed: false };
});

const cancelSettlement = async ({ ownerAgentId, reference, reason = '', actor = 'External system' }) => withFinancialSession(async (session) => {
    const settlement = await PointOfSaleSettlement.findOne({ ownerAgentId, reference }).session(session);
    if (!settlement) throw serviceError('SETTLEMENT_NOT_FOUND', 'التسوية غير موجودة.', 404);
    if (settlement.status === 'cancelled') return { settlement, replayed: true };
    if (settlement.status !== 'awaiting_external_confirmation') throw serviceError('SETTLEMENT_NOT_CANCELLABLE', 'لا يمكن إلغاء هذه التسوية بحالتها الحالية.', 409);
    const customer = await PointOfSaleCustomer.findOneAndUpdate(
        { _id: settlement.customerId, ownerAgentId, reservedBalance: { $gte: settlement.amount } },
        { $inc: { reservedBalance: -settlement.amount } }, { new: true, session }
    );
    if (!customer) throw serviceError('SETTLEMENT_RESERVATION_MISSING', 'حجز رصيد التسوية غير صالح.', 409);
    settlement.status = 'cancelled';
    settlement.reservedAfter = customer.reservedBalance;
    settlement.trace.push({ event: 'external_settlement_cancelled', actor, details: { reason: String(reason).slice(0, 300) } });
    await settlement.save({ session });
    return { settlement, replayed: false };
});

module.exports = { money, serviceError, requestSettlement, confirmSettlement, cancelSettlement };
