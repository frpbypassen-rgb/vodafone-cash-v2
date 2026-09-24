'use strict';

const {
    isValidOtpEmail,
    resolveAccountOtpEmail,
    selectLoginOtpChannel
} = require('../utils/otpDeliveryChannel');

describe('login OTP delivery channel', () => {
    test('stays on WhatsApp unless the account explicitly selects email', () => {
        const withEmail = {
            email: 'staff@example.com',
            businessProfile: { email: 'owner@example.com' }
        };
        expect(selectLoginOtpChannel(withEmail)).toEqual({ channel: 'whatsapp' });
        expect(selectLoginOtpChannel({ ...withEmail, otpDeliveryChannel: 'whatsapp' })).toEqual({ channel: 'whatsapp' });
        expect(selectLoginOtpChannel({})).toEqual({ channel: 'whatsapp' });
    });

    test('selects email only when the flag and a valid address are both present', () => {
        expect(selectLoginOtpChannel({
            otpDeliveryChannel: 'email',
            businessProfile: { email: 'Owner@Example.com' }
        })).toEqual({ channel: 'email', email: 'owner@example.com' });

        expect(selectLoginOtpChannel({
            otpDeliveryChannel: 'email',
            email: 'staff@example.com',
            businessProfile: { email: 'owner@example.com' }
        })).toEqual({ channel: 'email', email: 'staff@example.com' });
    });

    test('rejects an explicit email channel when the address is missing or invalid', () => {
        expect(selectLoginOtpChannel({ otpDeliveryChannel: 'email' }).code).toBe('EMAIL_OTP_ADDRESS_INVALID');
        expect(selectLoginOtpChannel({
            otpDeliveryChannel: 'email',
            email: 'not-an-email'
        }).code).toBe('EMAIL_OTP_ADDRESS_INVALID');
        expect(isValidOtpEmail('a@b.c')).toBe(false);
        expect(isValidOtpEmail('user@example.com')).toBe(true);
        expect(resolveAccountOtpEmail({ businessProfile: { email: '  Owner@Example.com ' } })).toBe('owner@example.com');
    });
});
