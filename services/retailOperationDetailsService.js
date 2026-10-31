'use strict';
const mongoose = require('mongoose');
const Transaction = require('../models/Transaction');
const { SERVICE_CATALOG, STATUS_META } = require('./portalWorkspace/catalog');
const { buildClientReceiptImages, getClientReceiptProofIds } = require('./clientReceiptService');
const { customerNoteFromTransaction } = require('../utils/transactionNotes');
const { sanitizeStatementText } = require('../utils/accountStatementPrivacy');
const missing = () =>
    Object.assign(new Error('العملية أو الإثبات غير موجود ضمن حسابك.'), { statusCode: 404 });
const scope = (ctx) => {
    if (!['User', 'SubAccount'].includes(ctx.actorModel) || !ctx.actor?._id) throw missing();
    const own =
        ctx.actorModel === 'SubAccount'
            ? { subAccountId: ctx.actor._id }
            : {
                  userId: {
                      $in: [String(ctx.actor._id), ctx.actor.phone, ctx.actor.webUsername].filter(Boolean),
                  },
                  companyId: null,
                  subAccountId: null,
              };
    return { ...own, tenantId: ctx.actor.tenantId || null };
};
const findOwn = async (ctx, id) => {
    if (!mongoose.isValidObjectId(id)) throw missing();
    const tx = await Transaction.findOne({ $and: [{ _id: id }, scope(ctx)] }).lean();
    if (!tx) throw missing();
    return tx;
};
const present = (tx, actorModel) => {
    const service = SERVICE_CATALOG.find((s) => s.key === tx.transferType);
    const bank = ['bank_account', 'bank_transfer'].includes(tx.transferType);
    return {
        id: String(tx._id),
        reference: tx.customId || String(tx._id),
        service: service?.label || 'تحويل',
        status: STATUS_META[tx.status]?.label || 'قيد المتابعة',
        tone: STATUS_META[tx.status]?.tone || 'neutral',
        amount: tx.amount,
        currency: service?.amountCurrencyCode || 'EGP',
        costLYD:
            actorModel === 'SubAccount'
                ? (tx.agencyPricing?.customerChargeLYD ?? tx.subAccountCostLYD ?? tx.costLYD)
                : tx.costLYD,
        exchangeRate:
            actorModel === 'SubAccount'
                ? (tx.agencyPricing?.customerRate ?? tx.subClientRate ?? tx.exchangeRate)
                : tx.exchangeRate,
        recipient: bank
            ? tx.accountNumber || tx.vodafoneNumber || ''
            : tx.vodafoneNumber || tx.accountNumber || '',
        recipientName: tx.accountName || '',
        createdAt: tx.createdAt || null,
        completedAt: tx.completedAt || null,
        notes: sanitizeStatementText(customerNoteFromTransaction(tx)),
        cancellationReason: sanitizeStatementText(tx.cancellationReason || ''),
        receipts: buildClientReceiptImages(tx).map((image) => ({
            label: image.label,
            url: `/client/api/retail-transactions/${tx._id}/proof/${image.index}`,
        })),
    };
};
const proof = (tx, index) => {
    if (!/^\d{1,3}$/.test(String(index))) throw missing();
    const id = getClientReceiptProofIds(tx)[Number(index)];
    if (!id) throw missing();
    return id;
};
module.exports = { scope, findOwn, present, proof };
