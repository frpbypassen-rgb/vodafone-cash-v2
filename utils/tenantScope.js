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

// Admin directory-style queries (companies, executors, users, and the
// single-tenant central-ledger overview). Production often resolves a new
// DEFAULT_TENANT_SLUG while older rows still carry a historical tenantId
// (or none). Filtering those widgets by the current tenant hides active
// companies, funded executors, and completed ops whose tenant predates the
// default. Multi-tenant keeps a hard tenant boundary.
const adminAccountScope = (source, options = {}) => {
    if (tenantMode() === 'single') return {};
    return tenantScope(source, options);
};

const tenantWriteId = (source) => tenantIdFrom(source) || undefined;

module.exports = { adminAccountScope, tenantScope, tenantWriteId };
