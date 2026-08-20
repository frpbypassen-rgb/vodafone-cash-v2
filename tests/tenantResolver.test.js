'use strict';

jest.mock('../models/Tenant', () => ({
    findById: jest.fn(),
    findOne: jest.fn()
}));

jest.mock('../utils/logger', () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn()
}));

const Tenant = require('../models/Tenant');
const {
    tenantResolver,
    invalidateTenantCache,
    resolveTenantSlugFromHost
} = require('../middlewares/tenantResolver');

const originalEnv = { ...process.env };
const activeTenant = {
    _id: 'tenant-ahram-id',
    slug: 'ahram',
    status: 'active'
};

const queryResult = (value) => ({ lean: jest.fn().mockResolvedValue(value) });
const runResolver = async ({ headers = {}, session = {} } = {}) => {
    const req = { headers, session };
    const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
    };
    const next = jest.fn();
    await tenantResolver(req, res, next);
    return { req, res, next };
};

describe('Trusted tenant resolution', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        invalidateTenantCache();
        process.env = {
            ...originalEnv,
            NODE_ENV: 'test',
            TENANT_MODE: 'single',
            TENANT_ISOLATION_REQUIRED: 'false',
            DEFAULT_TENANT_ID: '',
            DEFAULT_TENANT_SLUG: '',
            TENANT_ROOT_DOMAIN: '',
            TENANT_ROUTING_SECRET: ''
        };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    test('does not accept an arbitrary X-Tenant-ID override', async () => {
        const { res, next } = await runResolver({
            headers: { 'x-tenant-id': 'tenant-other-id' }
        });

        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            code: 'TENANT_OVERRIDE_FORBIDDEN'
        }));
        expect(Tenant.findById).not.toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
    });

    test('accepts an explicitly routed tenant only with the internal routing secret', async () => {
        process.env.TENANT_ROUTING_SECRET = 'tenant-routing-secret-that-is-at-least-32-characters';
        Tenant.findById.mockReturnValue(queryResult(activeTenant));

        const { req, next } = await runResolver({
            headers: {
                'x-tenant-id': 'tenant-ahram-id',
                'x-tenant-routing-secret': process.env.TENANT_ROUTING_SECRET
            }
        });

        expect(next).toHaveBeenCalledTimes(1);
        expect(req.tenant).toEqual(activeTenant);
        expect(req.tenantId).toBe(activeTenant._id);
        expect(req.session.tenantId).toBe(activeTenant._id);
    });

    test('never falls back when an explicitly requested tenant does not exist', async () => {
        process.env.TENANT_ROUTING_SECRET = 'tenant-routing-secret-that-is-at-least-32-characters';
        process.env.DEFAULT_TENANT_SLUG = 'ahram';
        Tenant.findById.mockReturnValue(queryResult(null));

        const { res, next } = await runResolver({
            headers: {
                'x-tenant-id': 'missing-tenant',
                'x-tenant-routing-secret': process.env.TENANT_ROUTING_SECRET
            }
        });

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TENANT_NOT_FOUND' }));
        expect(Tenant.findOne).not.toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
    });

    test('uses only the configured default tenant and never the first active record', async () => {
        process.env.TENANT_ISOLATION_REQUIRED = 'true';
        process.env.DEFAULT_TENANT_SLUG = 'ahram';
        Tenant.findOne.mockReturnValue(queryResult(activeTenant));

        const { req, next } = await runResolver({ headers: { host: 'ahrampay.com' } });

        expect(Tenant.findOne).toHaveBeenCalledWith({ slug: 'ahram' });
        expect(Tenant.findOne).not.toHaveBeenCalledWith({ status: 'active' });
        expect(req.tenant._id).toBe(activeTenant._id);
        expect(next).toHaveBeenCalledTimes(1);
    });

    test('fails closed when isolation is required but no tenant is configured', async () => {
        process.env.TENANT_ISOLATION_REQUIRED = 'true';

        const { res, next } = await runResolver({ headers: { host: 'ahrampay.com' } });

        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            code: 'TENANT_CONFIGURATION_ERROR'
        }));
        expect(next).not.toHaveBeenCalled();
    });

    test('fails closed when the tenant database lookup fails', async () => {
        process.env.DEFAULT_TENANT_SLUG = 'ahram';
        Tenant.findOne.mockReturnValue({
            lean: jest.fn().mockRejectedValue(new Error('database unavailable'))
        });

        const { res, next } = await runResolver();

        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            code: 'TENANT_RESOLUTION_FAILED'
        }));
        expect(next).not.toHaveBeenCalled();
    });

    test('resolves a subdomain only inside the configured multi-tenant root', () => {
        process.env.TENANT_MODE = 'multi';
        process.env.TENANT_ROOT_DOMAIN = 'ahrampay.com';

        expect(resolveTenantSlugFromHost({ headers: { host: 'zone.ahrampay.com' } })).toBe('zone');
        expect(resolveTenantSlugFromHost({ headers: { host: 'zone.attacker.test' } })).toBe('');
        expect(resolveTenantSlugFromHost({ headers: { host: 'ahrampay.com' } })).toBe('');
    });
});
