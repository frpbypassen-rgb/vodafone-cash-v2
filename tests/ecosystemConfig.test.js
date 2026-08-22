'use strict';

const ecosystem = require('../ecosystem.config');

describe('PM2 environment isolation', () => {
    test('pins production and staging to separate ports and env files', () => {
        const core = ecosystem.apps.find((app) => app.name === 'Ahram_Core_API');
        const staging = ecosystem.apps.find((app) => app.name === 'Ahram_Staging_API');

        expect(core.env_production).toMatchObject({
            NODE_ENV: 'production',
            PORT: '3000',
            DOTENV_CONFIG_PATH: '.env'
        });
        expect(staging.env_staging).toMatchObject({
            NODE_ENV: 'staging',
            PORT: '3100',
            DOTENV_CONFIG_PATH: '.env.staging'
        });
    });
});
