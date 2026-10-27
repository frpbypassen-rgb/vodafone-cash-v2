'use strict';
const fs = require('node:fs');
const path = require('node:path');
// Never run this config against an old app that does not implement the probe gate.
if (
    !fs
        .readFileSync(path.join(__dirname, 'app.js'), 'utf8')
        .includes('runtimeRoleGate(process.env)')
) {
    throw new Error(
        'Probe configuration requires the role-aware application release.',
    );
}
module.exports = {
    apps: [
        {
            name: 'ahram-pay-probe',
            script: path.join(__dirname, 'app.js'),
            cwd: __dirname,
            exec_mode: 'fork',
            instances: 1,
            watch: false,
            autorestart: false,
            env: {
                NODE_ENV: 'production',
                DOTENV_CONFIG_PATH: '.env',
                TZ: 'Africa/Tripoli',
                PORT: '3001',
                HTTP_BIND_HOST: '127.0.0.1',
                RUNTIME_ROLE: 'probe',
                APP_INSTANCE_COUNT: '2',
                REDIS_REQUIRED: 'true',
                BULLMQ_WORKERS_ENABLED: 'false',
                FINANCIAL_SCHEDULERS_ENABLED: 'false',
                MERCHANT_WEBHOOK_WORKER_ENABLED: 'false',
                EXTERNAL_API_ENABLED: 'false',
                AGENT_REPORT_EMAIL_ENABLED: 'false',
                COMPANY_REPORT_EMAIL_ENABLED: 'false',
            },
        },
    ],
};
