'use strict';

const { assertDemoScriptAllowed, assertNotProduction } = require('../utils/scriptSafety');

describe('demo/seed script safety', () => {
    test('refuses production unconditionally', () => {
        expect(() => assertNotProduction('seed-accounts.js', { NODE_ENV: 'production' }))
            .toThrow(/NODE_ENV=production/);
        expect(() => assertDemoScriptAllowed('seed-accounts.js', { NODE_ENV: 'production' }))
            .toThrow(/not allowed against a live system/);
    });

    test('refuses staging unless ALLOW_STAGING_DEMO_SEED is set', () => {
        expect(() => assertDemoScriptAllowed('seed-accounts.js', { NODE_ENV: 'staging' }))
            .toThrow(/ALLOW_STAGING_DEMO_SEED/);
        expect(() => assertDemoScriptAllowed('seed-accounts.js', {
            NODE_ENV: 'staging',
            ALLOW_STAGING_DEMO_SEED: 'true'
        })).not.toThrow();
    });

    test('allows local development', () => {
        expect(() => assertDemoScriptAllowed('seed-accounts.js', { NODE_ENV: 'development' }))
            .not.toThrow();
    });
});
