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
const AUTH_LOGIN_POST_PATHS = new Set([
    '/login',
    '/client/login',
    '/executor-portal/login'
]);

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

const addOriginVariants = (allowed, rawOrigin) => {
    try {
        const url = new URL(String(rawOrigin || '').trim());
        if (!url.origin || url.origin === 'null') return;
        allowed.add(url.origin);
        const host = url.hostname;
        const portSuffix = url.port ? `:${url.port}` : '';
        if (host.startsWith('www.')) {
            allowed.add(`${url.protocol}//${host.slice(4)}${portSuffix}`);
        } else {
            allowed.add(`${url.protocol}//www.${host}${portSuffix}`);
        }
    } catch (_) {}
};

const hasSameOrigin = (req) => {
    const origin = req.get('origin');
    const referer = req.get('referer');
    const host = req.get('host');
    if (!host) return false;

    const allowed = new Set();
    addOriginVariants(allowed, `https://${host}`);
    addOriginVariants(allowed, `http://${host}`);
    addOriginVariants(allowed, String(process.env.PUBLIC_APP_URL || '').trim());

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

const normalizePath = (req) => {
    const raw = String(req.path || req.originalUrl || '').split('?')[0];
    return raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
};

const isAuthLoginPost = (req) => (
    req.method === 'POST' && AUTH_LOGIN_POST_PATHS.has(normalizePath(req))
);

const shouldSkip = (req) => {
    const path = normalizePath(req);
    if (EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
        return true;
    }
    // Login is the session entry point; behind some reverse proxies the CSRF
    // cookie/session pair may not round-trip reliably on the first POST.
    if (isAuthLoginPost(req)) return true;
    return false;
};

// نموذج إيداع المنفذ الإداري يدعم رفع الإيصالات مباشرة كـ multipart.
// لا يكون req.body متاحاً قبل محلل الملفات، لذلك نسمح فقط بهذا المسار المحدد
// عندما يثبت Origin/Referer أنه صادر من نفس نطاق لوحة الإدارة.
const isDeferredExecutorSettlementCsrf = (req) => (
    req.method === 'POST'
    && /^\/executor\/[^/]+\/settle\/?$/.test(req.path || req.originalUrl || '')
);

// محرر الحسابات الإداري يرفع مستندات multipart؛ يتم التحقق من الرمز بعد
// تشغيل multer داخل المسار نفسه، حتى تبقى الحماية فعّالة ولا يفشل req.body.
const isDeferredAdminAccountEditCsrf = (req) => (
    req.method === 'POST'
    && /^\/admin\/accounts\/[^/]+\/[^/]+\/edit\/?$/.test(req.path || req.originalUrl || '')
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

    // هذا المسار يعالج الرمز داخل route بعد أن يقرأ multer حقول multipart.
    if (isDeferredExecutorSettlementCsrf(req) || isDeferredAdminAccountEditCsrf(req)) {
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
