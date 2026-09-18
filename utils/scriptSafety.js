'use strict';

const { isProduction, nodeEnv } = require('./runtimeEnv');

const DEMO_WARNING = 'DEMO-ONLY script. Generated credentials are placeholders and must never be used in production.';

const assertNotProduction = (scriptName, env = process.env) => {
    if (isProduction(env)) {
        throw new Error(
            `${scriptName} refuses to run when NODE_ENV=production. Demo/seed/reset tools are not allowed against a live system.`
        );
    }
};

const assertDemoScriptAllowed = (scriptName, env = process.env) => {
    assertNotProduction(scriptName, env);
    if (nodeEnv(env) === 'staging' && !['1', 'true', 'yes', 'on'].includes(String(env.ALLOW_STAGING_DEMO_SEED || '').trim().toLowerCase())) {
        throw new Error(
            `${scriptName} refuses to run in staging unless ALLOW_STAGING_DEMO_SEED=true.`
        );
    }
};

module.exports = {
    DEMO_WARNING,
    assertDemoScriptAllowed,
    assertNotProduction
};
