'use strict';
const { isKenanFollowupEnabled } = require('../utils/runtimeControls');
test.each([
    [{ NODE_ENV: 'production', FINANCIAL_SCHEDULERS_ENABLED: 'false' }, true],
    [{ NODE_ENV: 'production', KENAN_AUTO_FOLLOWUP_ENABLED: 'false' }, false],
    [{ NODE_ENV: 'production', EXTERNAL_API_ENABLED: 'false' }, false],
    [{ NODE_ENV: 'production', RUNTIME_ROLE: 'probe', KENAN_AUTO_FOLLOWUP_ENABLED: 'true' }, false],
    [{ APP_ENV: 'staging', EXTERNAL_API_ENABLED: 'true' }, false],
    [{ APP_ENV: 'staging', EXTERNAL_API_ENABLED: 'true', KENAN_AUTO_FOLLOWUP_ENABLED: 'true' }, true]
])('Kenan follow-up respects its own switch and runtime isolation (%j)', (env, expected) => {
    expect(isKenanFollowupEnabled(env)).toBe(expected);
});
