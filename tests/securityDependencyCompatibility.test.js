'use strict';
const { createRequire } = require('node:module');
test('locked modern glob and minimatch copies exclude the reviewed vulnerable ranges', () => {
    const { packages } = require('../package-lock.json');
    for (const [name, entry] of Object.entries(packages)) {
        const [major, minor, patch] = String(entry.version || '').split('.').map(Number);
        if (/(?:^|\/)node_modules\/glob$/.test(name) && major >= 9) {
            expect(major > 14 || (major === 14 && (minor > 0 || patch >= 2))).toBe(true);
        }
        if (/(?:^|\/)node_modules\/minimatch$/.test(name) && major >= 7) {
            expect(major > 11 || (major === 11 && (minor > 0 || patch >= 1))).toBe(true);
        }
    }
});
test('patched glob preserves Swagger route discovery and generation', () => {
    const { convertGlobPaths } = require('swagger-jsdoc/src/utils');
    expect(convertGlobPaths(['./routes/mobileApi.js'])).toHaveLength(1);
    const spec = require('../config/swagger');
    expect(spec.openapi).toBe('3.0.0');
    expect(Object.keys(spec.paths).length).toBeGreaterThan(0);
});
test('patched glob exposes the async and sync interfaces used by rimraf', async () => {
    const rimrafRequire = createRequire(require.resolve('rimraf'));
    const { glob, globSync } = rimrafRequire('glob');
    expect(globSync('routes/mobileApi.js')).toHaveLength(1);
    expect(await glob('routes/mobileApi.js')).toHaveLength(1);
    expect(typeof require('firebase-admin').initializeApp).toBe('function');
});
