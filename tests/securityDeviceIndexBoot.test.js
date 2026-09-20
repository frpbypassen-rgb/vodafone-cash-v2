'use strict';

const fs = require('fs');
const path = require('path');

describe('SecurityDevice index boot path', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'securityControlService.js'), 'utf8');

    test('does not drop the live unique device index on every process start', () => {
        expect(source).toMatch(/if \(!indexNames\.has\('uniq_active_security_device_per_account'\)\)/);
        expect(source).toMatch(/name: 'security_device_lastSeenAt'/);
        expect(source).not.toMatch(/for \(const index of previousIndexes\) await SecurityDevice\.collection\.dropIndex/);
    });
});
