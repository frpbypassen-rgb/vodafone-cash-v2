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
    }
}, { timestamps: true });

accountCodeSchema.index({ ownerModel: 1, ownerId: 1 }, { unique: true });

module.exports = mongoose.model('AccountCode', accountCodeSchema);
