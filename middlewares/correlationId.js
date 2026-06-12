// middlewares/correlationId.js
// ===============================================
// 🔗 Middleware — توليد معرّف فريد لكل طلب (Correlation ID)
// ===============================================
'use strict';

const crypto = require('crypto');

/**
 * يضيف correlationId فريد لكل request.
 * يُستخدم في error envelope وlogs لتتبع الطلبات.
 */
const correlationId = (req, res, next) => {
    req.correlationId = req.headers['x-correlation-id'] || `req_${crypto.randomBytes(8).toString('hex')}`;
    res.setHeader('X-Correlation-Id', req.correlationId);
    next();
};

module.exports = correlationId;
