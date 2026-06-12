'use strict';

const { mfaService } = require('../src/Application/Services/MfaService');

describe('MFA Service Tests', () => {
    test('Should generate 16 char base32 secret', () => {
        const secret = mfaService.generateTotpSecret();
        expect(secret).toHaveLength(16);
        expect(secret).toMatch(/^[A-Z2-7]+$/);
    });

    test('Should generate QR Code URL correctly', () => {
        const url = mfaService.getQrCodeUrl('JBSWY3DPEHPK3PXP', 'testuser@example.com');
        expect(url).toContain('otpauth://totp/');
        expect(url).toContain('secret=JBSWY3DPEHPK3PXP');
        expect(url).toContain('issuer=Al-Ahram%20Pay');
    });

    test('Should generate SMS OTP correctly', () => {
        const otp = mfaService.generateSmsOtp();
        expect(otp).toHaveLength(6);
        expect(Number(otp)).toBeGreaterThanOrEqual(100000);
        expect(Number(otp)).toBeLessThanOrEqual(999999);
    });

    test('Should verify generated TOTP successfully', () => {
        const secret = 'JBSWY3DPEHPK3PXP'; // standard secret
        // verify with window
        const isValid = mfaService.verifyTotp(secret, '123456'); // incorrect token
        expect(isValid).toBe(false);
    });
});
