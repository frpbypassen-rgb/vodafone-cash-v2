'use strict';

const fs = require('fs');
const path = require('path');
const {
    DEFAULT_TOUCH_AFTER_SECONDS,
    mongoSessionStoreOptions,
    sessionTouchAfterSeconds
} = require('../config/sessionStore');

describe('Mongo session store options', () => {
    test('throttles connect-mongo session touches to at least 30 seconds', () => {
        expect(sessionTouchAfterSeconds({})).toBe(DEFAULT_TOUCH_AFTER_SECONDS);
        expect(sessionTouchAfterSeconds({ SESSION_TOUCH_AFTER_SECONDS: '120' })).toBe(120);
        expect(sessionTouchAfterSeconds({ SESSION_TOUCH_AFTER_SECONDS: '5' })).toBe(DEFAULT_TOUCH_AFTER_SECONDS);
        expect(mongoSessionStoreOptions({
            mongoUrl: 'mongodb://127.0.0.1:27017/ahram',
            ttlSeconds: 7200,
            env: { SESSION_TOUCH_AFTER_SECONDS: '180' }
        })).toMatchObject({
            autoRemove: 'native',
            touchAfter: 180,
            ttl: 7200
        });
    });

    test('wires the throttled store into the production session middleware', () => {
        const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
        expect(appSource).toMatch(/mongoSessionStoreOptions\(/);
        expect(appSource).toMatch(/resave:\s*false/);
        expect(appSource).toMatch(/rolling:\s*true/);
    });
});
