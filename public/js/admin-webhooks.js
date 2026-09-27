'use strict';

// The admin page must not paint empty counts when the load failed.
// A successful payload with empty arrays is a real empty result.
// Anything else (HTTP error, success !== true, or a body without the arrays)
// is a load failure.
const classifyAdminWebhookLoad = (status, body) => {
    const httpOk = Number.isInteger(status) && status >= 200 && status < 300;
    if (!httpOk || !body || body.success !== true) return { ok: false };
    if (!Array.isArray(body.endpoints) || !Array.isArray(body.deliveries)) return { ok: false };
    const summary = body.summary && typeof body.summary === 'object' ? body.summary : {};
    return {
        ok: true,
        endpoints: body.endpoints,
        deliveries: body.deliveries,
        summary
    };
};

const api = { classifyAdminWebhookLoad };
if (typeof module === 'object' && module.exports) {
    module.exports = api;
} else if (typeof window !== 'undefined') {
    window.classifyAdminWebhookLoad = classifyAdminWebhookLoad;
}
