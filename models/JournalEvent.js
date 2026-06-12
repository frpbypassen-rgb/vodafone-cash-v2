const mongoose = require('mongoose');

const journalEventSchema = new mongoose.Schema({
    eventType: { type: String, required: true },
    entityId: { type: mongoose.Schema.Types.ObjectId, required: true },
    entityModel: { type: String, required: true },
    amount: { type: Number, required: true },
    currency: { type: String, required: true, default: 'EGP' },
    sequenceNumber: { type: Number, required: true },
    metadata: { type: mongoose.Schema.Types.Mixed },
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' }
}, { timestamps: { createdAt: true, updatedAt: false } });

journalEventSchema.index({ entityId: 1, sequenceNumber: 1 }, { unique: true });
journalEventSchema.index({ eventType: 1, createdAt: -1 });
journalEventSchema.index({ tenantId: 1 });

module.exports = mongoose.model('JournalEvent', journalEventSchema);
