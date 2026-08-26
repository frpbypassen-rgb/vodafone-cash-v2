'use strict';

const crypto = require('crypto');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXEMPT_PREFIXES = [
    '/api/mobile',
    '/api/v1/mobile',
    '/api/v1/merchant',
    '/metrics',
    '/health'
];

const escapeHtml = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const ensureToken = (req) => {
    if (!req.session) return null;
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }
    return req.session.csrfToken;
};

const hasSameOrigin = (req) => {
    const origin = req.get('origin');
    const referer = req.get('referer');
    const host = req.get('host');
    if (!host) return false;

    const allowed = new Set([
        `http://${host}`,
        `https://${host}`
    ]);
    // خلف الـ reverse proxy قد يصل Host إلى Node كعنوان داخلي مثل
    // 127.0.0.1:3000، بينما Origin الصحيح الذي يرسله المتصفح هو النطاق
    // العام. أضف النطاق المعرّف رسميًا ولا تثق في قيمة قادمة من العميل.
    try {
        const publicOrigin = new URL(String(process.env.PUBLIC_APP_URL || '').trim()).origin;
        if (publicOrigin && publicOrigin !== 'null') allowed.add(publicOrigin);
    } catch (_) {}

    if (origin) return allowed.has(origin);
    if (referer) {
        try {
            return allowed.has(new URL(referer).origin);
        } catch (_) {
            return false;
        }
    }
    return false;
};

const shouldSkip = (req) => {
    const path = req.path || req.originalUrl || '';
    return EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
};

// نموذج إيداع المنفذ الإداري يدعم رفع الإيصالات مباشرة كـ multipart.
// لا يكون req.body متاحاً قبل محلل الملفات، لذلك نسمح فقط بهذا المسار المحدد
// عندما يثبت Origin/Referer أنه صادر من نفس نطاق لوحة الإدارة.
const isSameOriginExecutorSettlementUpload = (req) => (
    req.method === 'POST'
    && /^\/executor\/[^/]+\/settle\/?$/.test(req.path || req.originalUrl || '')
    && String(req.get('content-type') || '').toLowerCase().startsWith('multipart/form-data')
    && hasSameOrigin(req)
);

const injectTokenIntoHtml = (html, token) => {
    if (!token || typeof html !== 'string' || !html.includes('<form')) return html;
    const hiddenInput = `<input type="hidden" name="_csrf" value="${escapeHtml(token)}">`;
    return html.replace(/(<form\b(?=[^>]*method=["']?post["']?)[^>]*>)(?![\s\S]*?<input[^>]+name=["']_csrf["'])/gi, `$1${hiddenInput}`);
};

const csrfProtection = (req, res, next) => {
    const token = ensureToken(req);
    res.locals.csrfToken = token;

    const originalSend = res.send.bind(res);
    res.send = (body) => {
        const contentType = String(res.getHeader('content-type') || '');
        if (token && typeof body === 'string' && (contentType.includes('text/html') || body.includes('<html') || body.includes('<form'))) {
            return originalSend(injectTokenIntoHtml(body, token));
        }
        return originalSend(body);
    };

    if (SAFE_METHODS.has(req.method) || shouldSkip(req)) {
        return next();
    }

    if (isSameOriginExecutorSettlementUpload(req)) {
        return next();
    }

    const submittedToken = req.get('x-csrf-token') || req.body?._csrf;
    if (submittedToken && token) {
        const submitted = Buffer.from(String(submittedToken));
        const expected = Buffer.from(String(token));
        if (submitted.length === expected.length && crypto.timingSafeEqual(submitted, expected)) {
            return next();
        }
    }

    const allowLegacySameOrigin = process.env.ALLOW_LEGACY_SAME_ORIGIN_CSRF === 'true'
        && process.env.NODE_ENV !== 'production';

    if (allowLegacySameOrigin && hasSameOrigin(req)) {
        return next();
    }

    return res.status(403).json({
        success: false,
        error: 'Invalid CSRF token'
    });
};

module.exports = csrfProtection;
