const mongoose = require('mongoose');

const auditSchema = new mongoose.Schema({
    action: { type: String, required: true },
    actorId: { type: String, default: '' },
    actorName: { type: String, default: '' },
    note: { type: String, default: '', maxlength: 1000 },
    at: { type: Date, default: Date.now }
}, { _id: false });

const clientServiceRequestSchema = new mongoose.Schema({
    requestType: { type: String, enum: ['payment_request', 'scheduled_transfer', 'bill_payment'], required: true },
    ownerId: { type: String, required: true, index: true },
    ownerType: { type: String, enum: ['user', 'sub_client'], required: true },
    ownerName: { type: String, required: true, maxlength: 160 },
    status: { type: String, enum: ['pending_admin', 'approved', 'rejected', 'cancelled', 'awaiting_integration'], default: 'pending_admin', index: true },
    payload: { type: mongoose.Schema.Types.Mixed, default: {} },
    adminNote: { type: String, default: '', maxlength: 1000 },
    reviewedById: { type: String, default: '' },
    reviewedByName: { type: String, default: '' },
    reviewedAt: { type: Date },
    audit: { type: [auditSchema], default: [] }
}, { timestamps: true });

clientServiceRequestSchema.index({ status: 1, createdAt: -1 });
clientServiceRequestSchema.index({ ownerId: 1, createdAt: -1 });

module.exports = mongoose.model('ClientServiceRequest', clientServiceRequestSchema);
