'use strict';

const { hashOtp, verifyOtp } = require('../utils/otp');

describe('OTP security', () => {
    const originalOtpSecret = process.env.OTP_SECRET;

    beforeAll(() => {
        process.env.OTP_SECRET = 'test-otp-secret-0123456789-abcdefghijklmnopqrstuvwxyz';
    });

    afterAll(() => {
        if (originalOtpSecret === undefined) delete process.env.OTP_SECRET;
        else process.env.OTP_SECRET = originalOtpSecret;
    });

    test('accepts only the OTP matching its HMAC digest', () => {
        const digest = hashOtp('482913');
        expect(verifyOtp('482913', digest)).toBe(true);
        expect(verifyOtp('482914', digest)).toBe(false);
    });

    test('rejects plaintext and malformed OTP storage', () => {
        expect(verifyOtp('200104', '200104')).toBe(false);
        expect(verifyOtp('12345', hashOtp('12345'))).toBe(false);
        expect(verifyOtp('1234567', hashOtp('1234567'))).toBe(false);
    });
});
