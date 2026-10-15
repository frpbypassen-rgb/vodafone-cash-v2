'use strict';

const mongoose = require('mongoose');
const FinancialOffice = require('../models/FinancialOffice');
const MerchantAccount = require('../models/MerchantAccount');

const tenantFilter = (req) => {
    const tenantId = req?.tenant?._id || req?.tenant?.id;
    if (tenantId) return { tenantId };
    return { $or: [{ tenantId: null }, { tenantId: { $exists: false } }] };
};

const validId = (value) => mongoose.isValidObjectId(value);

const listPortalDepositReferences = async (req) => {
    const scope = tenantFilter(req);
    const [offices, merchants] = await Promise.all([
        FinancialOffice.find({ ...scope, status: 'active' }).select('_id name code').sort({ name: 1 }).lean(),
        MerchantAccount.find({ ...scope, status: 'active' }).select('_id name code officeId').sort({ name: 1 }).lean()
    ]);
    return { offices, merchants };
};

const resolvePortalDepositReferences = async (req, { officeId, merchantId }) => {
    if (!validId(officeId) || !validId(merchantId)) {
        const error = new Error('يجب اختيار المكتب والتاجر قبل إرسال الإيداع.');
        error.status = 400;
        throw error;
    }
    const scope = tenantFilter(req);
    const [office, merchant] = await Promise.all([
        FinancialOffice.findOne({ ...scope, _id: officeId, status: 'active' }).select('_id name code').lean(),
        MerchantAccount.findOne({ ...scope, _id: merchantId, status: 'active' }).select('_id name code officeId').lean()
    ]);
    if (!office || !merchant) {
        const error = new Error('المكتب أو التاجر المحدد غير متاح.');
        error.status = 400;
        throw error;
    }
    if (merchant.officeId && String(merchant.officeId) !== String(office._id)) {
        const error = new Error('التاجر المحدد لا يتبع المكتب المختار.');
        error.status = 400;
        throw error;
    }
    return { office, merchant };
};

module.exports = { listPortalDepositReferences, resolvePortalDepositReferences };
