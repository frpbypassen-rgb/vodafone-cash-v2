'use strict';

jest.mock('../middlewares/tenantResolver', () => ({ tenantMode: () => 'single' }));

const { tenantScope, tenantWriteId } = require('../utils/tenantScope');

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
});
