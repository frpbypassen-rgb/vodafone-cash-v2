'use strict';

const { tenantMode } = require('../middlewares/tenantResolver');

const isObjectId = (value) => Boolean(
    value
    && typeof value === 'object'
    && (value._bsontype === 'ObjectId' || typeof value.toHexString === 'function')
);

const tenantIdFrom = (source) => {
    if (source === null || source === undefined || source === '') return null;
    if (typeof source !== 'object' || isObjectId(source)) return source;
    // Request and options objects without a resolved tenant represent the
    // single-tenant legacy scope. Never pass the whole object to Mongoose.
    return source.tenantId || source.tenant?._id || null;
};

const tenantScope = (source, { includeLegacy = true } = {}) => {
    const tenantId = tenantIdFrom(source);
    if (!tenantId) return {};
    if (includeLegacy && tenantMode() === 'single') {
        return { tenantId: { $in: [tenantId, null] } };
    }
    return { tenantId };
};

const tenantWriteId = (source) => tenantIdFrom(source) || undefined;

module.exports = { tenantScope, tenantWriteId };
