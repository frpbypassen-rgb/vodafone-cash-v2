'use strict';

const { deviceTrustEngine } = require('../src/Application/Services/DeviceTrustEngine');

describe('Device Trust Engine Tests', () => {
    const sig1 = {
        ip: '192.168.1.10',
        userAgent: 'Mozilla/5.0 Chrome/120.0',
        fingerprint: 'fp-abc-123'
    };

    const sig2 = {
        ip: '192.168.1.20',
        userAgent: 'Mozilla/5.0 Safari/605',
        fingerprint: 'fp-xyz-789'
    };

    test('Should calculate hash fingerprint', () => {
        const fp1 = deviceTrustEngine.calculateFingerprint(sig1);
        const fp2 = deviceTrustEngine.calculateFingerprint(sig1);
        const fp3 = deviceTrustEngine.calculateFingerprint(sig2);

        expect(fp1).toBe(fp2);
        expect(fp1).not.toBe(fp3);
    });

    test('Should register and trust device', () => {
        const userId = 'user-123';
        const isTrustedBefore = deviceTrustEngine.isDeviceTrusted(userId, sig1);
        expect(isTrustedBefore).toBe(true); // first device is auto trusted

        const isTrustedAfterSig1 = deviceTrustEngine.isDeviceTrusted(userId, sig1);
        expect(isTrustedAfterSig1).toBe(true);

        const isTrustedAfterSig2 = deviceTrustEngine.isDeviceTrusted(userId, sig2);
        expect(isTrustedAfterSig2).toBe(false); // different signature is untrusted
    });
});
