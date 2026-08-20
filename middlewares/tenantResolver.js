// middlewares/tenantResolver.js
// ===============================================
// Tenant resolution with trusted, fail-closed routing.
// ===============================================
'use strict';

const crypto = require('crypto');
const Tenant = require('../models/Tenant');
const logger = require('../utils/logger');

const _tenantCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
const VALID_TENANT_MODES = new Set(['single', 'multi']);

const clean = (value) => String(value || '').trim();
const tenantMode = () => {
    const configured = clean(process.env.TENANT_MODE).toLowerCase();
    return VALID_TENANT_MODES.has(configured) ? configured : 'single';
};
const tenantIsolationRequired = () => (
    clean(process.env.NODE_ENV).toLowerCase() === 'production'
    || clean(process.env.TENANT_ISOLATION_REQUIRED).toLowerCase() === 'true'
);

const safeEqual = (left, right) => {
    const leftBuffer = Buffer.from(clean(left));
    const rightBuffer = Buffer.from(clean(right));
    return leftBuffer.length > 0
        && leftBuffer.length === rightBuffer.length
        && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const responseError = (res, status, code, message) => res.status(status).json({
    success: false,
    code,
    message
});

const requestedTenantId = (req) => clean(req.headers['x-tenant-id']);
const hasTrustedRoutingSecret = (req) => {
    const configuredSecret = clean(process.env.TENANT_ROUTING_SECRET);
    return configuredSecret.length >= 32
        && safeEqual(req.headers['x-tenant-routing-secret'], configuredSecret);
};

const sessionTenantMatches = (req, tenantId) => {
    const sessionTenantId = clean(req.session && req.session.tenantId);
    return Boolean(sessionTenantId && tenantId && sessionTenantId === clean(tenantId));
};

const normalizeHostname = (req) => {
    const forwardedHost = clean(req.headers['x-forwarded-host']).split(',')[0];
    const rawHost = forwardedHost || clean(req.headers.host);
    return rawHost.toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
};

const resolveTenantSlugFromHost = (req) => {
    if (tenantMode() !== 'multi') return '';

    const rootDomain = clean(process.env.TENANT_ROOT_DOMAIN).toLowerCase().replace(/^\.+|\.+$/g, '');
    const hostname = normalizeHostname(req);
    if (!rootDomain || !hostname || hostname === rootDomain || !hostname.endsWith(`.${rootDomain}`)) {
        return '';
    }

    const subdomain = hostname.slice(0, -(rootDomain.length + 1));
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain)) return '';
    return subdomain;
};

const resolveConfiguredDefaultTenant = async () => {
    const defaultTenantId = clean(process.env.DEFAULT_TENANT_ID);
    const defaultTenantSlug = clean(process.env.DEFAULT_TENANT_SLUG).toLowerCase();
    if (defaultTenantId) return _getTenantById(defaultTenantId);
    if (defaultTenantSlug) return _getTenantBySlug(defaultTenantSlug);
    return null;
};

/**
 * Tenant selection is based only on trusted server configuration, an approved
 * host name, a dedicated tenant API credential, or a tenant-bound session.
 * Arbitrary client headers can never override the current tenant.
 */
const tenantResolver = async (req, res, next) => {
    try {
        let tenant = null;
        const explicitTenantId = requestedTenantId(req);

        if (explicitTenantId) {
            const trusted = hasTrustedRoutingSecret(req) || sessionTenantMatches(req, explicitTenantId);
            if (!trusted) {
                return responseError(res, 403, 'TENANT_OVERRIDE_FORBIDDEN', 'غير مصرح بتغيير نطاق المنظمة');
            }
            tenant = await _getTenantById(explicitTenantId);
            if (!tenant) {
                return responseError(res, 404, 'TENANT_NOT_FOUND', 'المنظمة المطلوبة غير موجودة');
            }
        }

        if (!tenant) {
            const tenantApiKey = clean(req.headers['x-tenant-api-key']);
            if (tenantApiKey) {
                tenant = await _getTenantByApiKey(tenantApiKey);
                if (!tenant) {
                    return responseError(res, 401, 'TENANT_CREDENTIAL_INVALID', 'بيانات المنظمة غير صالحة');
                }
            }
        }

        if (!tenant) {
            const hostSlug = resolveTenantSlugFromHost(req);
            if (hostSlug) {
                tenant = await _getTenantBySlug(hostSlug);
                if (!tenant) {
                    return responseError(res, 404, 'TENANT_NOT_FOUND', 'المنظمة المطلوبة غير موجودة');
                }
            }
        }

        if (!tenant) tenant = await resolveConfiguredDefaultTenant();

        if (!tenant && tenantIsolationRequired()) {
            logger.error('Tenant resolution failed closed: no configured tenant', {
                mode: tenantMode(),
                hostname: normalizeHostname(req)
            });
            return responseError(res, 503, 'TENANT_CONFIGURATION_ERROR', 'تعذر تحديد المنظمة بأمان');
        }

        if (tenant && !['active', 'trial'].includes(tenant.status)) {
            return responseError(res, 403, 'TENANT_SUSPENDED', 'حساب المنظمة معلق');
        }

        req.tenant = tenant || null;
        req.tenantId = tenant ? tenant._id : null;
        if (req.session && tenant) req.session.tenantId = String(tenant._id);
        return next();
    } catch (error) {
        logger.error('Tenant resolution failed closed', { error: error.message });
        return responseError(res, 503, 'TENANT_RESOLUTION_FAILED', 'تعذر التحقق من نطاق المنظمة');
    }
};

const _getTenantById = async (id) => {
    const cacheKey = `id:${id}`;
    const cached = _getFromCache(cacheKey);
    if (cached) return cached;

    const tenant = await Tenant.findById(id).lean();
    if (tenant) _setInCache(cacheKey, tenant);
    return tenant;
};

const _getTenantByApiKey = async (apiKey) => {
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const cacheKey = `key:${keyHash}`;
    const cached = _getFromCache(cacheKey);
    if (cached) return cached;

    const tenant = await Tenant.findOne({ apiKey }).lean();
    if (tenant) _setInCache(cacheKey, tenant);
    return tenant;
};

const _getTenantBySlug = async (slug) => {
    const normalizedSlug = clean(slug).toLowerCase();
    const cacheKey = `slug:${normalizedSlug}`;
    const cached = _getFromCache(cacheKey);
    if (cached) return cached;

    const tenant = await Tenant.findOne({ slug: normalizedSlug }).lean();
    if (tenant) _setInCache(cacheKey, tenant);
    return tenant;
};

const _getFromCache = (key) => {
    const item = _tenantCache.get(key);
    if (!item) return null;
    if (Date.now() > item.expiry) {
        _tenantCache.delete(key);
        return null;
    }
    return item.value;
};

const _setInCache = (key, value) => {
    _tenantCache.set(key, { value, expiry: Date.now() + CACHE_TTL });
};

const invalidateTenantCache = () => {
    _tenantCache.clear();
};

module.exports = {
    tenantResolver,
    invalidateTenantCache,
    resolveTenantSlugFromHost,
    tenantIsolationRequired,
    tenantMode
};
