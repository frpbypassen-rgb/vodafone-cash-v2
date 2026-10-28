'use strict';
const crypto = require('node:crypto');
const slots = {
    created: 'merchantWebhookCreatedEvent', completed: 'merchantWebhookCompletedEvent', cancelled: 'merchantWebhookCancelledEvent',
};
const terminal = status => status === 'completed' ? 'completed'
    : ['rejected', 'cancelled_by_admin', 'cancelled', 'canceled', 'failed'].includes(status) ? 'cancelled' : null;
const eligible = tx => Boolean(tx.companyId || tx.userId || tx.clientActorId)
    && !['balance_transfer', 'deposit', 'deduction'].includes(tx.transferType)
    && ['pending','accepted','processing','completed','rejected','cancelled_by_admin'].includes(tx.status);
const event = (kind, tx) => {
    const type = 'transfer.' + kind, at = new Date();
    return { eventType: type, eventId: `${tx._id}:${type}:${tx.status}`, pending: true, stagedAt: at,
        source: { _id: tx._id, companyId: tx.companyId || null, userId: tx.userId || '',
            clientActorModel: tx.clientActorModel, clientActorId: tx.clientActorId, tenantId: tx.tenantId || null },
        payload: { id: crypto.randomUUID(), type, created_at: at.toISOString(), data: {
            transaction_id: String(tx._id), reference: tx.customId, status: tx.status, transfer_type: tx.transferType,
            amount: Number(tx.amount || 0), cost_lyd: Number(tx.costLYD || 0), exchange_rate: Number(tx.exchangeRate || 0),
            completed_at: tx.completedAt || null, cancellation_number: tx.cancellationNumber || null,
            cancellation_reason: tx.cancellationReason || null,
        } },
    };
};
const attach = (schema) => {
    for (const field of Object.values(slots)) schema.add({ [field]: { type: Object, select: false } });
    schema.pre('save', function() {
        if (!eligible(this)) return;
        if (this.isNew) this.set(slots.created, event('created', this));
        const kind = terminal(this.status);
        if (kind && (this.isNew || this.isModified('status'))) this.set(slots[kind], event(kind, this));
    });
    // All existing business terminal query writes are single-document operations.
    // Stage the snapshot in the very same update and existing Mongo session.
    for (const method of ['findOneAndUpdate','updateOne']) schema.pre(method, async function() {
        const update = this.getUpdate();
        const status = update?.$set?.status || update?.status;
        const kind = terminal(status);
        if (!kind) return;
        const prior = await this.model.findOne(this.getFilter()).session(this.getOptions().session || null).lean();
        if (!prior || prior.status === status) return;
        const after = { ...prior, ...update, ...update.$set, status };
        delete after.$set;
        for (const [key,value] of Object.entries(update.$inc || {})) {
            if (['amount','costLYD','exchangeRate'].includes(key)) after[key] = Number(prior[key] || 0) + Number(value);
        }
        if (!eligible(after)) return;
        // Normalize ordinary assignment updates to operator form; preserve all other operators.
        const next = { ...update, $set: { ...update.$set, [slots[kind]]: event(kind, after) } };
        for (const key of Object.keys(next)) if (!key.startsWith('$')) { next.$set[key] = next[key]; delete next[key]; }
        this.setUpdate(next);
    });
};
module.exports = { attach, slots, event, eligible, terminal };
