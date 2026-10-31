'use strict';
const { classifyPassword } = require('../scripts/auditCredentialStorage.cjs');
test('distinguishes legacy and malformed values from complete bcrypt hashes', () => {
    expect(classifyPassword('test-only-password')).toBe('legacyOrInvalid');
    expect(classifyPassword('$2b$12$short')).toBe('legacyOrInvalid');
    expect(classifyPassword({ $ne: null })).toBe('missing');
    expect(classifyPassword('')).toBe('missing');
    expect(classifyPassword('$2b$12$' + 'A'.repeat(53))).toBe('bcrypt12OrHigher');
    expect(classifyPassword('$2b$10$' + 'A'.repeat(53))).toBe('bcryptBelow12');
});
