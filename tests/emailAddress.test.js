'use strict';

const fs = require('fs');
const path = require('path');
const {
    EMAIL_INVALID_MESSAGE,
    EMAIL_REQUIRED_MESSAGE,
    EMAIL_TAKEN_MESSAGE,
    classifyEmailAddress,
    isValidEmailAddress
} = require('../utils/emailAddress');

describe('shared account email address', () => {
    test.each([
        ['tzdanallybyh@gmail.com', 'tzdanallybyh@gmail.com'],
        ['  TZDANALLYBYH@Gmail.COM ', 'tzdanallybyh@gmail.com'],
        ['user.name+tag@gmail.com', 'user.name+tag@gmail.com'],
        ['a_b-c.d@yahoo.com', 'a_b-c.d@yahoo.com'],
        ['digits123@hotmail.com', 'digits123@hotmail.com'],
        ['first.last@outlook.com', 'first.last@outlook.com'],
        ['owner@custom-domain.co.uk', 'owner@custom-domain.co.uk'],
        ['staff@ahrampay.com', 'staff@ahrampay.com'],
        ['staff@sub.ahrampay.com', 'staff@sub.ahrampay.com'],
        ['person@example.technology', 'person@example.technology'],
        ['a1@b2.io', 'a1@b2.io'],
        ['owner@my_domain.com', 'owner@my_domain.com']
    ])('accepts %j as %j', (input, expected) => {
        expect(classifyEmailAddress(input)).toEqual({
            ok: true,
            email: expected,
            code: '',
            message: ''
        });
        expect(isValidEmailAddress(input)).toBe(true);
    });

    test.each([
        ['', 'required', EMAIL_REQUIRED_MESSAGE],
        ['   ', 'required', EMAIL_REQUIRED_MESSAGE],
        ['not-an-email', 'invalid', EMAIL_INVALID_MESSAGE],
        ['a@b.c', 'invalid', EMAIL_INVALID_MESSAGE],
        ['user@localhost', 'invalid', EMAIL_INVALID_MESSAGE],
        ['user@domain', 'invalid', EMAIL_INVALID_MESSAGE],
        ['@gmail.com', 'invalid', EMAIL_INVALID_MESSAGE],
        ['user@', 'invalid', EMAIL_INVALID_MESSAGE],
        ['user@@gmail.com', 'invalid', EMAIL_INVALID_MESSAGE],
        ['user@.com', 'invalid', EMAIL_INVALID_MESSAGE],
        ['user@gmail..com', 'invalid', EMAIL_INVALID_MESSAGE],
        ['user@-gmail.com', 'invalid', EMAIL_INVALID_MESSAGE],
        [`user@${'a'.repeat(250)}.com`, 'invalid', EMAIL_INVALID_MESSAGE]
    ])('rejects %j as %s', (input, code, message) => {
        expect(classifyEmailAddress(input)).toMatchObject({ ok: false, email: '', code, message });
        expect(isValidEmailAddress(input)).toBe(false);
        expect(message).not.toBe(EMAIL_TAKEN_MESSAGE);
    });

    test('public registration uses the shared validator', () => {
        const view = fs.readFileSync(path.join(__dirname, '../views/client/register.ejs'), 'utf8');
        expect(view).toContain('window.AhramEmailAddress');
        expect(view).toContain("include('../partials/required_owner_email_script')");
        expect(view).not.toContain('/^\\S+@\\S+\\.\\S+$/');
    });

    test('does not use the taken-email message for a malformed address', () => {
        expect(EMAIL_TAKEN_MESSAGE).toBe('هذا البريد الإلكتروني مستخدم في حساب آخر.');
        expect(classifyEmailAddress('tzdanallybyh@gmail.com').message).not.toBe(EMAIL_TAKEN_MESSAGE);
        expect(classifyEmailAddress('not-an-email').message).toBe(EMAIL_INVALID_MESSAGE);
    });
});
