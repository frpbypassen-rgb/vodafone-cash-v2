'use strict';

const { isStrongAdminPassword } = require('../utils/adminPasswordPolicy');

test('new admin accounts require a strong password at both creation endpoints', () => {
    expect(isStrongAdminPassword('VeryStrong#123')).toBe(true);
    expect(isStrongAdminPassword('short#1A')).toBe(false);
    expect(isStrongAdminPassword('alllowercase#123')).toBe(false);
    expect(isStrongAdminPassword('ALLUPPERCASE#123')).toBe(false);
    expect(isStrongAdminPassword('NoDigitsHere!')).toBe(false);
    expect(isStrongAdminPassword('NoSpecial1234')).toBe(false);
});
