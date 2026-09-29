'use strict';

const {
    isEmailOtpEnabled,
    isValidOtpEmail,
    isWhatsappLoginOtpEnabled,
    isWhatsappOtpEnabled,
    resolveAccountOtpEmail,
    selectLoginOtpChannel
} = require('../utils/otpDeliveryChannel');

describe('account-level login OTP delivery policy', () => {
    test('does not request OTP unless administration explicitly enables email OTP', () => {
        expect(selectLoginOtpChannel({})).toEqual({
            channel: 'disabled',
            code: 'LOGIN_OTP_NOT_ENABLED'
        });
        expect(selectLoginOtpChannel({ email: 'staff@example.com' })).toEqual({
            channel: 'disabled',
            code: 'LOGIN_OTP_NOT_ENABLED'
        });
        expect(selectLoginOtpChannel({
            email: 'staff@example.com',
            otpDeliveryChannel: 'whatsapp'
        })).toEqual({
            channel: 'disabled',
            code: 'LOGIN_OTP_NOT_ENABLED'
        });
    });

    test('uses email only for an explicitly enabled account with a valid stored address', () => {
        expect(selectLoginOtpChannel({
            otpDeliveryChannel: 'email',
            businessProfile: { email: ' Owner@Example.com ' }
        })).toEqual({ channel: 'email', email: 'owner@example.com' });
        expect(selectLoginOtpChannel({
            otpDeliveryChannel: 'email',
            email: 'staff@example.com',
            businessProfile: { email: 'owner@example.com' }
        })).toEqual({ channel: 'email', email: 'staff@example.com' });
    });

    test('fails closed when administration enables email OTP without a valid address', () => {
        expect(selectLoginOtpChannel({ otpDeliveryChannel: 'email' }).code)
            .toBe('EMAIL_OTP_ADDRESS_INVALID');
        expect(selectLoginOtpChannel({
            otpDeliveryChannel: 'email',
            email: 'not-an-email'
        }).code).toBe('EMAIL_OTP_ADDRESS_INVALID');
        expect(isValidOtpEmail('a@b.c')).toBe(false);
        expect(isValidOtpEmail('user@example.com')).toBe(true);
        expect(resolveAccountOtpEmail({ businessProfile: { email: ' Owner@Example.com ' } }))
            .toBe('owner@example.com');
    });

    test('never selects WhatsApp for login OTP, regardless of global WhatsApp flags', () => {
        for (const env of [
            {},
            { WHATSAPP_OTP_ENABLED: 'true', WHATSAPP_LOGIN_OTP_ENABLED: 'true' },
            { WHATSAPP_OTP_ENABLED: 'false', WHATSAPP_LOGIN_OTP_ENABLED: 'true' }
        ]) {
            expect(selectLoginOtpChannel({ otpDeliveryChannel: 'whatsapp' }, env)).toEqual({
                channel: 'disabled',
                code: 'LOGIN_OTP_NOT_ENABLED'
            });
        }
        expect(isWhatsappLoginOtpEnabled({ WHATSAPP_LOGIN_OTP_ENABLED: 'true' })).toBe(true);
        expect(isWhatsappOtpEnabled({ WHATSAPP_OTP_ENABLED: 'true' })).toBe(true);
    });

    test('respects the email delivery kill switch after per-account enablement', () => {
        expect(isEmailOtpEnabled({})).toBe(true);
        expect(selectLoginOtpChannel({
            otpDeliveryChannel: 'email',
            email: 'staff@example.com'
        }, { EMAIL_OTP_ENABLED: 'false' })).toEqual({
            channel: 'email',
            email: 'staff@example.com',
            code: 'EMAIL_OTP_DISABLED'
        });
    });
});
