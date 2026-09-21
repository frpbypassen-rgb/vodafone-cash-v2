'use strict';

const {
    absoluteSessionExpiresAtForPolicy,
    phoneLengthModeFromLengths,
    readCompanyExecutionPolicy,
    readExecutorManualPolicy,
    serializeCompanyExecutionPolicy,
    serializeEmployeePolicyOverride,
    validateSenderPhoneDigits,
    webSessionMaxAgeMsForPolicy
} = require('../utils/executorManualPolicy');

describe('executor execution policy', () => {
    test('maps phone-length modes to a single length or all three', () => {
        expect(phoneLengthModeFromLengths([3])).toBe('3');
        expect(phoneLengthModeFromLengths([4])).toBe('4');
        expect(phoneLengthModeFromLengths([11])).toBe('11');
        expect(phoneLengthModeFromLengths([3, 4, 11])).toBe('all');
        expect(phoneLengthModeFromLengths([3, 4])).toBe('all');
    });

    test('enforces configured sender digit lengths', () => {
        expect(validateSenderPhoneDigits('258', { allowedPhoneLengths: [3] }).ok).toBe(true);
        expect(validateSenderPhoneDigits('2258', { allowedPhoneLengths: [3] }).ok).toBe(false);
        expect(validateSenderPhoneDigits('2258', { allowedPhoneLengths: [4] }).ok).toBe(true);
        expect(validateSenderPhoneDigits('01108172258', { allowedPhoneLengths: [11] }).ok).toBe(true);
        expect(validateSenderPhoneDigits('258', { allowedPhoneLengths: [11] }).ok).toBe(false);
        expect(validateSenderPhoneDigits('258', { allowedPhoneLengths: [3, 4, 11] }).ok).toBe(true);
        expect(validateSenderPhoneDigits('2258', { allowedPhoneLengths: [3, 4, 11] }).ok).toBe(true);
    });

    test('inherits company defaults until an employee override is set', () => {
        const group = {
            manualProofRequired: true,
            manualAllowedPhoneLengths: [4],
            maxConcurrentDevices: 2,
            sessionTtlEnabled: false
        };
        const inherited = readExecutorManualPolicy(group, { executionPolicyOverride: {} });
        expect(inherited.proofRequired).toBe(true);
        expect(inherited.allowedPhoneLengths).toEqual([4]);
        expect(inherited.phoneLengthMode).toBe('4');
        expect(inherited.maxConcurrentDevices).toBe(2);
        expect(inherited.sessionTtlEnabled).toBe(false);
        expect(inherited.inherited.proofRequired).toBe(true);

        const overridden = readExecutorManualPolicy(group, {
            executionPolicyOverride: {
                proofRequired: false,
                allowedPhoneLengths: [3],
                maxConcurrentDevices: 5,
                sessionTtlEnabled: true,
                sessionTtlSeconds: 3600
            }
        });
        expect(overridden.proofRequired).toBe(false);
        expect(overridden.allowedPhoneLengths).toEqual([3]);
        expect(overridden.maxConcurrentDevices).toBe(5);
        expect(overridden.sessionTtlEnabled).toBe(true);
        expect(overridden.sessionTtlSeconds).toBe(3600);
        expect(overridden.inherited.proofRequired).toBe(false);
        expect(overridden.company.proofRequired).toBe(true);
    });

    test('keeps sessions open when TTL is turned off', () => {
        expect(absoluteSessionExpiresAtForPolicy({ sessionTtlEnabled: false })).toBe(0);
        expect(webSessionMaxAgeMsForPolicy({ sessionTtlEnabled: false })).toBe(30 * 24 * 60 * 60 * 1000);
        const enabled = { sessionTtlEnabled: true, sessionTtlSeconds: 3600 };
        const now = Date.now();
        expect(absoluteSessionExpiresAtForPolicy(enabled, now)).toBe(now + 3600 * 1000);
        expect(webSessionMaxAgeMsForPolicy(enabled)).toBe(3600 * 1000);
    });

    test('serializes company and employee policy payloads including hours', () => {
        const company = serializeCompanyExecutionPolicy({
            phoneLengthMode: '3',
            proofRequired: true,
            maxConcurrentDevices: 1,
            sessionTtlEnabled: true,
            sessionTtlHours: 2
        });
        expect(company.manualAllowedPhoneLengths).toEqual([3]);
        expect(company.manualProofRequired).toBe(true);
        expect(company.maxConcurrentDevices).toBe(1);
        expect(company.sessionTtlEnabled).toBe(true);
        expect(company.sessionTtlSeconds).toBe(7200);

        expect(serializeEmployeePolicyOverride({ inheritCompanyPolicy: true })).toEqual({});
        const override = serializeEmployeePolicyOverride({
            phoneLengthMode: '11',
            proofRequired: false,
            maxConcurrentDevices: 5,
            sessionTtlEnabled: false
        });
        expect(override.allowedPhoneLengths).toEqual([11]);
        expect(override.proofRequired).toBe(false);
        expect(override.maxConcurrentDevices).toBe(5);
        expect(override.sessionTtlEnabled).toBe(false);
    });

    test('company policy defaults to no idle logout and one device', () => {
        const policy = readCompanyExecutionPolicy({});
        expect(policy.maxConcurrentDevices).toBe(1);
        expect(policy.sessionTtlEnabled).toBe(false);
        expect(policy.sessionTtlSeconds).toBeNull();
        expect(policy.phoneLengthMode).toBe('all');
    });
});
