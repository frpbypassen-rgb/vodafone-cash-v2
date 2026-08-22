'use strict';

const { isEnvironmentAdminLoginEnabled } = require('../config/adminAuthPolicy');

describe('admin authentication policy', () => {
    test('environment credentials are disabled by default', () => {
        expect(isEnvironmentAdminLoginEnabled({})).toBe(false);
    });

    test('environment credentials require an explicit true value', () => {
        expect(isEnvironmentAdminLoginEnabled({ ENABLE_ENV_ADMIN_LOGIN: 'true' })).toBe(true);
        expect(isEnvironmentAdminLoginEnabled({ ENABLE_ENV_ADMIN_LOGIN: 'TRUE' })).toBe(true);
        expect(isEnvironmentAdminLoginEnabled({ ENABLE_ENV_ADMIN_LOGIN: '1' })).toBe(false);
        expect(isEnvironmentAdminLoginEnabled({ ENABLE_ENV_ADMIN_LOGIN: 'false' })).toBe(false);
    });
});
