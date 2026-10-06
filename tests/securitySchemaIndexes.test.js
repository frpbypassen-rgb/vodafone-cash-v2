'use strict';

const Tenant = require('../models/Tenant');
const TrustedDevice = require('../models/TrustedDevice');

test.each([
    ['slug', { unique: true }],
    ['apiKey', { unique: true, sparse: true }]
])('tenant %s has one index with its uniqueness options', (field, options) => {
    const indexes = Tenant.schema.indexes().filter(([fields]) => (
        Object.keys(fields).length === 1 && fields[field] === 1
    ));
    expect(indexes).toHaveLength(1);
    expect(indexes[0][1]).toMatchObject(options);
});

test('trusted device expiration has one TTL index', () => {
    const indexes = TrustedDevice.schema.indexes().filter(([fields]) => (
        Object.keys(fields).length === 1 && fields.expiresAt === 1
    ));
    expect(indexes).toHaveLength(1);
    expect(indexes[0][1].expireAfterSeconds).toBe(0);
});
