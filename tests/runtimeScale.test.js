'use strict';

const { configuredInstanceCount, distributedStateRequired } = require('../config/runtimeScale');

describe('runtime scale policy', () => {
    test('requires distributed state in production even when a stale flag says false', () => {
        expect(distributedStateRequired({ NODE_ENV: 'production', REDIS_REQUIRED: 'false' })).toBe(true);
    });

    test('requires distributed state for multiple instances outside production', () => {
        expect(configuredInstanceCount({ APP_INSTANCE_COUNT: '4' })).toBe(4);
        expect(distributedStateRequired({ NODE_ENV: 'staging', APP_INSTANCE_COUNT: '4' })).toBe(true);
    });

    test('permits the memory fallback only for an explicit single-process development run', () => {
        expect(distributedStateRequired({ NODE_ENV: 'development', APP_INSTANCE_COUNT: '1' })).toBe(false);
    });
});
