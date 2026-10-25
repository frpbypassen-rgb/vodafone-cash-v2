'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
// Match filenames, not the absolute checkout path (which can itself contain
// "executor"). Never accidentally select the whole repository's test suite.
const files = fs.readdirSync(path.join(root, 'tests'))
    .filter(name => /^(executor|manualExecutor|splitPart|jwtExecutorStatus).*\.test\.js$/.test(name))
    .sort()
    .map(name => path.join(root, 'tests', name));
const environment = { ...process.env, NODE_ENV: 'test' };
for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'SESSION_SECRET', 'OTP_SECRET']) {
    environment[key] = crypto.randomBytes(32).toString('hex');
}
const result = spawnSync(process.execPath, [
    require.resolve('jest/bin/jest'), '--runInBand', '--runTestsByPath',
    ...files, ...process.argv.slice(2)
], { cwd: root, env: environment, stdio: 'inherit', windowsHide: true, timeout: 15 * 60 * 1000 });
if (result.error) {
    console.error('Executor test runner failed:', result.error.message);
}
process.exitCode = result.status ?? 1;
