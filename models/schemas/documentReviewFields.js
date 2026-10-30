'use strict';
module.exports = {
    reviewStatus: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
    reviewReason: { type: String, maxlength: 500, default: '' },
    reviewedAt: { type: Date, default: null },
};
