'use strict';

const {
    normalizeSourceIp,
    authorizeCompanyApiServer
} = require('../services/companyApiServerAccessService');

describe('company API source-server access', () => {
    const company = {
        apiAccessPolicy: {
            mode: 'locked',
            lockedServerId: 'server-1',
            servers: [{ _id: 'server-1', name: 'Production', sourceIp: '203.0.113.25', enabled: true }]
        }
    };

    test('normalizes literal IPv4 and mapped IPv4 values only', () => {
        expect(normalizeSourceIp(' ::ffff:203.0.113.25 ')).toBe('203.0.113.25');
        expect(normalizeSourceIp('api.example.com')).toBe('');
    });

    test('allows only the locked company server', () => {
        expect(authorizeCompanyApiServer({ company, req: { ip: '203.0.113.25' } }))
            .toEqual(expect.objectContaining({ allowed: true, sourceIp: '203.0.113.25' }));
        expect(authorizeCompanyApiServer({ company, req: { ip: '203.0.113.26' } }))
            .toEqual(expect.objectContaining({ allowed: false, code: 'API_SERVER_NOT_ALLOWED' }));
    });

    test('fails closed when a lock points to a missing or disabled server', () => {
        const broken = { apiAccessPolicy: { mode: 'locked', lockedServerId: 'missing', servers: [] } };
        expect(authorizeCompanyApiServer({ company: broken, req: { ip: '203.0.113.25' } }))
            .toEqual(expect.objectContaining({ allowed: false, code: 'API_SERVER_LOCK_MISCONFIGURED' }));
    });
});
