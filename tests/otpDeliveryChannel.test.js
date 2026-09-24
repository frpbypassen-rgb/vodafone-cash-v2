'use strict';

const {
    isValidOtpEmail,
    isWhatsappLoginOtpEnabled,
    resolveAccountOtpEmail,
    selectLoginOtpChannel
} = require('../utils/otpDeliveryChannel');

const whatsappOtpOff = { WHATSAPP_LOGIN_OTP_ENABLED: 'false' };

describe('login OTP delivery channel', () => {
    test('uses email when a valid address is stored and WhatsApp only when it is absent', () => {
        const withEmail = {
            email: 'staff@example.com',
            businessProfile: { email: 'owner@example.com' }
        };
        expect(selectLoginOtpChannel(withEmail)).toEqual({ channel: 'email', email: 'staff@example.com' });
        expect(selectLoginOtpChannel({ ...withEmail, otpDeliveryChannel: 'whatsapp' })).toEqual({
            channel: 'email',
            email: 'staff@example.com'
        });
        expect(selectLoginOtpChannel({})).toEqual({ channel: 'whatsapp' });
        expect(selectLoginOtpChannel({ otpDeliveryChannel: 'whatsapp', email: 'not-an-email' })).toEqual({
            channel: 'whatsapp'
        });
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

    test('keeps email when WhatsApp login OTP is disabled and a valid address exists', () => {
        expect(selectLoginOtpChannel({ email: 'staff@example.com' }, whatsappOtpOff)).toEqual({
            channel: 'email',
            email: 'staff@example.com'
        });
        expect(selectLoginOtpChannel({
            email: 'staff@example.com',
            otpDeliveryChannel: 'whatsapp'
        }, whatsappOtpOff)).toEqual({
            channel: 'email',
            email: 'staff@example.com'
        });
    });

    test('blocks WhatsApp login OTP only when the flag is explicitly off', () => {
        for (const value of ['0', 'false', 'no', 'off', ' FALSE ']) {
            expect(selectLoginOtpChannel({}, { WHATSAPP_LOGIN_OTP_ENABLED: value })).toEqual({
                channel: 'whatsapp',
                code: 'WHATSAPP_LOGIN_OTP_DISABLED'
            });
            expect(isWhatsappLoginOtpEnabled({ WHATSAPP_LOGIN_OTP_ENABLED: value })).toBe(false);
        }
        expect(selectLoginOtpChannel({
            otpDeliveryChannel: 'email',
            email: 'not-an-email'
        }, whatsappOtpOff).code).toBe('EMAIL_OTP_ADDRESS_INVALID');
    });

    test('keeps the WhatsApp channel when the flag is unset or truthy', () => {
        expect(selectLoginOtpChannel({}, {})).toEqual({ channel: 'whatsapp' });
        expect(isWhatsappLoginOtpEnabled({})).toBe(true);
        for (const value of ['1', 'true', 'yes', 'on']) {
            expect(selectLoginOtpChannel({}, { WHATSAPP_LOGIN_OTP_ENABLED: value })).toEqual({
                channel: 'whatsapp'
            });
        }
    });
});
