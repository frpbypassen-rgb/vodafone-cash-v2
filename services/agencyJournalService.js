'use strict';

const AgencyJournal = require('../models/AgencyJournal');
const SubAccount = require('../models/SubAccount');
const mongoose = require('mongoose');
const { pricingFromTransaction, roundMoney } = require('../utils/agencyPricing');

const ownerDescriptor = (subAccount, fallbackOwnerId) => ({
    ownerType: subAccount?.masterType === 'company' ? 'company' : 'agent',
    ownerId: subAccount?.masterId || fallbackOwnerId
});

const createEntry = async (payload, session) => {
    if (!payload.ownerId || !payload.transactionId || !payload.eventId) return null;
    const validObjectId = typeof mongoose.isValidObjectId === 'function'
        ? mongoose.isValidObjectId(payload.ownerId)
        : /^[a-f\d]{24}$/i.test(String(payload.ownerId));
    if (!validObjectId || typeof AgencyJournal !== 'function') return null;
    try {
        const entry = new AgencyJournal(payload);
        await entry.save(session ? { session } : {});
        return entry;
    } catch (error) {
        if (error?.code === 11000) {
            const existingEntry = await AgencyJournal.findOne({ eventId: payload.eventId });
            if (existingEntry) return existingEntry;
        }
        throw error;
    }
};

const transferLines = (pricing, customerId, ownerId) => {
    const lines = [
        {
            accountCode: 'CUSTOMER_BALANCE',
            label: 'Customer balance charged',
            side: 'debit',
            amount: pricing.customerChargeLYD,
            entityId: customerId,
            entityModel: 'SubAccount'
        },
        {
            accountCode: 'COMPANY_WALLET',
            label: 'Agency wallet cost',
            side: 'credit',
            amount: pricing.agentCostLYD,
            entityId: ownerId,
            entityModel: 'User'
        }
    ];
    if (pricing.profitLYD > 0) {
        lines.push({
            accountCode: 'AGENCY_MARGIN_REVENUE',
            label: 'Agency exchange margin',
            side: 'credit',
            amount: pricing.profitLYD,
            entityId: ownerId,
            entityModel: 'User'
        });
    }
    return lines;
};

const recordTransferReservation = async ({ transaction, subAccount, ownerId, actor }, session) => {
    if (!transaction?.isSubAccountTx || !transaction?.subAccountId) return null;
    const pricing = pricingFromTransaction(transaction);
    const owner = ownerDescriptor(subAccount, ownerId);
    return createEntry({
        eventId: `${transaction.customId}:TRANSFER_RESERVED`,
        ...owner,
        customerId: transaction.subAccountId,
        transactionId: transaction.customId,
        eventType: 'TRANSFER_RESERVED',
        status: 'reserved',
        pricing,
        lines: transferLines(pricing, transaction.subAccountId, owner.ownerId),
        createdById: actor?._id,
        createdByModel: actor?.model,
        createdByName: actor?.name
    }, session);
};

const resolveSubAccount = async (transaction) => {
    if (!transaction?.subAccountId) return null;
    return SubAccount.findById(transaction.subAccountId).select('masterType masterId').lean();
};

const recordTransferRealization = async (transaction) => {
    if (!transaction?.isSubAccountTx || !transaction?.subAccountId) return null;
    const subAccount = await resolveSubAccount(transaction);
    if (!subAccount) return null;
    const owner = ownerDescriptor(subAccount);
    return createEntry({
        eventId: `${transaction.customId}:TRANSFER_REALIZED`,
        ...owner,
        customerId: transaction.subAccountId,
        transactionId: transaction.customId,
        eventType: 'TRANSFER_REALIZED',
        status: 'posted',
        pricing: pricingFromTransaction(transaction),
        lines: [],
        metadata: { status: transaction.status }
    });
};

const recordTransferReversal = async (transaction, metadata = {}, session) => {
    if (!transaction?.isSubAccountTx || !transaction?.subAccountId) return null;
    const subAccount = await resolveSubAccount(transaction);
    if (!subAccount) return null;
    const owner = ownerDescriptor(subAccount);
    const pricing = pricingFromTransaction(transaction);
    const lines = transferLines(pricing, transaction.subAccountId, owner.ownerId).map((line) => ({
        ...line,
        side: line.side === 'debit' ? 'credit' : 'debit'
    }));
    return createEntry({
        eventId: `${transaction.customId}:TRANSFER_REVERSED`,
        ...owner,
        customerId: transaction.subAccountId,
        transactionId: transaction.customId,
        eventType: 'TRANSFER_REVERSED',
        status: 'reversed',
        pricing,
        lines,
        reversalOf: `${transaction.customId}:TRANSFER_RESERVED`,
        metadata
    }, session);
};

const deltaLine = ({ accountCode, label, delta, positiveSide, entityId, entityModel }) => {
    const value = roundMoney(Math.abs(delta));
    if (value <= 0) return null;
    return {
        accountCode,
        label,
        side: delta >= 0 ? positiveSide : (positiveSide === 'debit' ? 'credit' : 'debit'),
        amount: value,
        entityId,
        entityModel
    };
};

const recordTransferRepricing = async ({ transaction, subAccount, oldPricing, newPricing, actor, idempotencyKey }, session) => {
    if (!transaction?.isSubAccountTx || !subAccount) return null;
    const owner = ownerDescriptor(subAccount);
    const customerDelta = roundMoney(newPricing.customerChargeLYD - oldPricing.customerChargeLYD);
    const agencyDelta = roundMoney(newPricing.agentCostLYD - oldPricing.agentCostLYD);
    const profitDelta = roundMoney(customerDelta - agencyDelta);
    const ownerModel = owner.ownerType === 'company' ? 'ClientCompany' : 'User';
    const lines = [
        deltaLine({ accountCode: 'CUSTOMER_BALANCE', label: 'Transfer customer amount repriced', delta: customerDelta, positiveSide: 'debit', entityId: transaction.subAccountId, entityModel: 'SubAccount' }),
        deltaLine({ accountCode: 'COMPANY_WALLET', label: 'Transfer agency cost repriced', delta: agencyDelta, positiveSide: 'credit', entityId: owner.ownerId, entityModel: ownerModel }),
        deltaLine({ accountCode: 'AGENCY_MARGIN_REVENUE', label: 'Transfer margin repriced', delta: profitDelta, positiveSide: 'credit', entityId: owner.ownerId, entityModel: ownerModel })
    ].filter(Boolean);

    return createEntry({
        eventId: `${transaction.customId}:TRANSFER_REPRICED:${idempotencyKey}`,
        ...owner,
        customerId: transaction.subAccountId,
        transactionId: transaction.customId,
        eventType: 'TRANSFER_REPRICED',
        status: 'reserved',
        idempotencyKey,
        pricing: newPricing,
        lines,
        createdById: actor?._id,
        createdByModel: actor?.model,
        createdByName: actor?.name,
        metadata: { oldPricing, customerDelta, agencyDelta, profitDelta }
    }, session);
};

const SETTLEMENT_EVENT_TYPES = Object.freeze({
    customer_payment: 'CUSTOMER_PAYMENT',
    customer_payout: 'CUSTOMER_PAYOUT',
    debt_payment: 'DEBT_PAYMENT',
    balance_credit: 'BALANCE_CREDIT',
    balance_debit: 'BALANCE_DEBIT'
});

const recordCustomerSettlement = async ({
    transactionId,
    subAccount,
    category,
    amount,
    delta,
    idempotencyKey,
    actor,
    metadata
}, session) => {
    const owner = ownerDescriptor(subAccount);
    const value = roundMoney(Math.abs(amount));
    const isCredit = Number(delta) >= 0;
    const lines = isCredit
        ? [
            { accountCode: 'CUSTOMER_SETTLEMENT_CLEARING', label: 'Customer funds received', side: 'debit', amount: value, entityId: owner.ownerId, entityModel: 'User' },
            { accountCode: 'CUSTOMER_BALANCE', label: 'Customer balance funded', side: 'credit', amount: value, entityId: subAccount._id, entityModel: 'SubAccount' }
        ]
        : [
            { accountCode: 'CUSTOMER_BALANCE', label: 'Customer balance reduced', side: 'debit', amount: value, entityId: subAccount._id, entityModel: 'SubAccount' },
            { accountCode: 'CUSTOMER_SETTLEMENT_CLEARING', label: 'Customer payout or correction', side: 'credit', amount: value, entityId: owner.ownerId, entityModel: 'User' }
        ];

    return createEntry({
        eventId: `${transactionId}:${SETTLEMENT_EVENT_TYPES[category] || (isCredit ? 'BALANCE_CREDIT' : 'BALANCE_DEBIT')}`,
        ...owner,
        customerId: subAccount._id,
        transactionId,
        eventType: SETTLEMENT_EVENT_TYPES[category] || (isCredit ? 'BALANCE_CREDIT' : 'BALANCE_DEBIT'),
        status: 'posted',
        idempotencyKey,
        lines,
        createdById: actor?._id,
        createdByModel: actor?.model,
        createdByName: actor?.name,
        metadata
    }, session);
};

module.exports = {
    createEntry,
    recordTransferReservation,
    recordTransferRealization,
    recordTransferReversal,
    recordTransferRepricing,
    recordCustomerSettlement,
    SETTLEMENT_EVENT_TYPES
};
