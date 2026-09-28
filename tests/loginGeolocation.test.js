'use strict';

const fs = require('fs');
const path = require('path');

describe('Login geolocation must not block the UI', () => {
    const unified = fs.readFileSync(path.join(__dirname, '..', 'views', 'unified_login.ejs'), 'utf8');
    const executor = fs.readFileSync(path.join(__dirname, '..', 'views', 'executor', 'login.ejs'), 'utf8');

    test.each([
        ['unified login', unified],
        ['executor login', executor]
    ])('%s uses a short GPS wait and a cached position', (_label, source) => {
        expect(source).toMatch(/LOCATION_WAIT_MS\s*=\s*3500/);
        expect(source).toMatch(/maximumAge:\s*300000/);
        expect(source).toMatch(/enableHighAccuracy:\s*false/);
        expect(source).toMatch(/Promise\.race/);
        expect(source).not.toMatch(/enableHighAccuracy:\s*true,\s*timeout:\s*10000,\s*maximumAge:\s*0/);
    });
});
