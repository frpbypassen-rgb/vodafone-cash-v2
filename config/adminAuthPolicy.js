'use strict';

const isEnvironmentAdminLoginEnabled = (env = process.env) => (
    String(env.ENABLE_ENV_ADMIN_LOGIN || '').trim().toLowerCase() === 'true'
);

module.exports = {
    isEnvironmentAdminLoginEnabled
};
