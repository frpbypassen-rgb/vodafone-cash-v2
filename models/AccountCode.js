const mongoose = require('mongoose');

const accountCodeSchema = new mongoose.Schema({
    code: { type: String, required: true, unique: true, trim: true, index: true },
    ownerModel: {
        type: String,
        required: true,
        enum: ['User', 'ClientCompany', 'SubAccount']
    },
    ownerId: {
        type: mongoose.Schema.Types.ObjectId,
        required: true,
        index: true
    },
    // Optional. Uniqueness stays on `code` until scripts/prepareAccountCodeTenantIndex.js
    // is run explicitly after a clean duplicate scan. Do not add a unique compound index here.
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tenant' }
}, { timestamps: true });

accountCodeSchema.index({ ownerModel: 1, ownerId: 1 }, { unique: true });
accountCodeSchema.index({ tenantId: 1, code: 1 });

module.exports = mongoose.model('AccountCode', accountCodeSchema);
