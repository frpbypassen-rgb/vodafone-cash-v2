'use strict';
const { createRequire } = require('node:module');
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
