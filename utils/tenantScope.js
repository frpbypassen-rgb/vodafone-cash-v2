'use strict';

const { tenantMode } = require('../middlewares/tenantResolver');

const tenantIdFrom = (source) => source?.tenantId || source?.tenant?._id || source || null;

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
