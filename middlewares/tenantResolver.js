// middlewares/tenantResolver.js
// ===============================================
// 🏢 Tenant Resolution Middleware — Multi-Tenant
// ===============================================
'use strict';

const Tenant = require('../models/Tenant');
const logger = require('../utils/logger');

// كاش مؤقت للـ Tenants
const _tenantCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 دقائق

/**
 * Middleware لتحديد المستأجر (Tenant) من الطلب
 *
 * طرق التحديد (حسب الأولوية):
 * 1. Header: X-Tenant-ID
 * 2. API Key: X-API-Key
 * 3. Subdomain: ahram.example.com → slug = "ahram"
 * 4. Default: أول tenant نشط
 */
const tenantResolver = async (req, res, next) => {
    try {
        let tenant = null;

        // 1. من Header
        const tenantId = req.headers['x-tenant-id'];
        if (tenantId) {
            tenant = await _getTenantById(tenantId);
        }

        // 2. من API Key
        if (!tenant) {
            const apiKey = req.headers['x-api-key'];
            if (apiKey) {
                tenant = await _getTenantByApiKey(apiKey);
            }
        }

        // 3. من Subdomain
        if (!tenant) {
            const host = req.headers.host || '';
            const parts = host.split('.');
            if (parts.length > 2) {
                const slug = parts[0];
                tenant = await _getTenantBySlug(slug);
            }
        }

        // 4. Default tenant
        if (!tenant) {
            tenant = await _getDefaultTenant();
        }

        // التحقق من حالة المستأجر
        if (tenant && tenant.status !== 'active' && tenant.status !== 'trial') {
            return res.status(403).json({
                success: false,
                code: 'TENANT_SUSPENDED',
                message: 'حساب المنظمة معلق'
            });
        }

        // إضافة المستأجر للطلب
        req.tenant = tenant;
        next();
    } catch (error) {
        logger.error('Tenant resolution failed', { error: error.message });
        // لا نمنع الطلب — نتابع بدون tenant
        req.tenant = null;
        next();
    }
};

// ── Helper Functions ───────────────────────────

const _getTenantById = async (id) => {
    const cached = _getFromCache(`id:${id}`);
    if (cached) return cached;

    const tenant = await Tenant.findById(id).lean();
    if (tenant) _setInCache(`id:${id}`, tenant);
    return tenant;
};

const _getTenantByApiKey = async (apiKey) => {
    const cached = _getFromCache(`key:${apiKey}`);
    if (cached) return cached;

    const tenant = await Tenant.findOne({ apiKey }).lean();
    if (tenant) _setInCache(`key:${apiKey}`, tenant);
    return tenant;
};

const _getTenantBySlug = async (slug) => {
    const cached = _getFromCache(`slug:${slug}`);
    if (cached) return cached;

    const tenant = await Tenant.findOne({ slug }).lean();
    if (tenant) _setInCache(`slug:${slug}`, tenant);
    return tenant;
};

const _getDefaultTenant = async () => {
    const cached = _getFromCache('default');
    if (cached) return cached;

    const tenant = await Tenant.findOne({ status: 'active' }).sort({ createdAt: 1 }).lean();
    if (tenant) _setInCache('default', tenant);
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

/**
 * إبطال كاش المستأجرين
 */
const invalidateTenantCache = () => {
    _tenantCache.clear();
};

module.exports = { tenantResolver, invalidateTenantCache };
