'use strict';

const withEnvironment = (values, callback) => {
    const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
    Object.entries(values).forEach(([key, value]) => {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });

    try {
        return callback();
    } finally {
        Object.entries(previous).forEach(([key, value]) => {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        });
    }
};

describe('Sandbox merchant configuration', () => {
    const { sandboxConfiguration } = require('../services/sandboxMerchantProvisioningService');

    test('accepts a separate sandbox database and HTTPS endpoint', () => {
        const config = withEnvironment({
            MONGO_URI: 'mongodb://127.0.0.1:27017/ahram_pay',
            SANDBOX_MONGO_URI: 'mongodb://127.0.0.1:27018/ahram_pay_sandbox?replicaSet=rs0',
            SANDBOX_API_URL: 'https://sandbox-api.ahrampay.com/',
            SANDBOX_DEFAULT_MERCHANT_BALANCE: '75000'
        }, () => sandboxConfiguration());

        expect(config).toMatchObject({
            apiOrigin: 'https://sandbox-api.ahrampay.com',
            tenantSlug: 'ahram-sandbox',
            defaultBalance: 75000
        });
    });

    test('rejects a production MongoDB URI for sandbox credentials', () => {
        const provisionWithUnsafeDatabase = () => withEnvironment({
            MONGO_URI: 'mongodb://127.0.0.1:27017/ahram_pay',
            SANDBOX_MONGO_URI: 'mongodb://127.0.0.1:27017/ahram_pay',
            SANDBOX_API_URL: 'https://sandbox-api.ahrampay.com'
        }, () => sandboxConfiguration());

        expect(provisionWithUnsafeDatabase).toThrow('SANDBOX_DATABASE_UNSAFE');
        try {
            provisionWithUnsafeDatabase();
        } catch (error) {
            expect(error.code).toBe('SANDBOX_DATABASE_UNSAFE');
        }
    });
});
