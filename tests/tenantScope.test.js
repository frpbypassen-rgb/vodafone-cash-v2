'use strict';

jest.mock('../middlewares/tenantResolver', () => ({ tenantMode: () => 'single' }));

const { adminAccountScope, tenantScope, tenantWriteId } = require('../utils/tenantScope');

describe('tenant scope helpers', () => {
    test('does not treat an Express request without a tenant as a tenant id', () => {
        const request = { tenantId: null, tenant: null, headers: {}, session: {} };
        expect(tenantScope(request)).toEqual({});
        expect(tenantWriteId(request)).toBeUndefined();
    });

    test('scopes a request with a resolved tenant and legacy records', () => {
        const tenantId = { _bsontype: 'ObjectId', toHexString: () => '507f1f77bcf86cd799439011' };
        expect(tenantScope({ tenantId })).toEqual({ tenantId: { $in: [tenantId, null] } });
        expect(tenantWriteId({ tenantId })).toBe(tenantId);
    });

    test('does not hide single-tenant admin account widgets behind the resolved tenant', () => {
        const tenantId = { _bsontype: 'ObjectId', toHexString: () => '507f1f77bcf86cd799439011' };
        expect(adminAccountScope({ tenantId })).toEqual({});
        expect(adminAccountScope(tenantId)).toEqual({});
        expect(tenantScope({ tenantId })).toEqual({ tenantId: { $in: [tenantId, null] } });
    });

    test('keeps a hard tenant boundary for admin account widgets in multi-tenant mode', () => {
        jest.resetModules();
        jest.doMock('../middlewares/tenantResolver', () => ({ tenantMode: () => 'multi' }));
        const scoped = require('../utils/tenantScope');
        const tenantId = 'tenant-a';
        expect(scoped.adminAccountScope(tenantId)).toEqual({ tenantId });
        expect(scoped.tenantScope(tenantId)).toEqual({ tenantId });
    });
});
