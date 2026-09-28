'use strict';

const {
    PIN_REDACTION_TOKEN,
    PIN_SECURITY_NOTE_AR,
    buildUssdString,
    describeUssdForDebug,
    networkRequiresPin,
    normalizeUssdNetwork,
    redactUssdForLog,
    sanitizeAmountDigits,
    sanitizePhoneDigits,
    toTelUri,
    toPublicQuickExecuteState,
    validateDialInputs
} = require('../utils/executorQuickExecuteUssd');

describe('quick execute USSD builders', () => {
    const phone = '01108172258';
    const amount = 250;
    const pin = '1234';

    test('sanitizes eastern/arabic digits and strips non-digits from phone and amount', () => {
        expect(sanitizePhoneDigits('٠١١٠٨١٧٢٢٥٨')).toBe('01108172258');
        expect(sanitizePhoneDigits('+20 110-817-2258')).toBe('201108172258');
        expect(sanitizeAmountDigits('٢٥٠')).toBe('250');
        expect(sanitizeAmountDigits(250.4)).toBe('250');
        expect(sanitizeAmountDigits('1,250 ج.م')).toBe('1250');
    });

    test('builds Vodafone USSD without a PIN even if one is supplied', () => {
        expect(buildUssdString({ network: 'vodafone', phone, amount, pin })).toBe(
            '*9*7*01108172258*250#'
        );
        expect(buildUssdString({ network: 'vodafone', phone, amount })).toBe(
            '*9*7*01108172258*250#'
        );
        expect(networkRequiresPin('vodafone')).toBe(false);
    });

    test('builds Etisalat, Orange, and WE strings with the wallet PIN', () => {
        expect(buildUssdString({ network: 'etisalat', phone, amount, pin })).toBe(
            '*777*1*1234*250*01108172258*01108172258#'
        );
        expect(buildUssdString({ network: 'orange', phone, amount, pin })).toBe(
            '*7115*7*01108172258*250*1234#'
        );
        expect(buildUssdString({ network: 'we', phone, amount, pin })).toBe(
            '*7*2*01108172258*250*1234#'
        );
    });

    test('requires a PIN for Etisalat, Orange, and WE', () => {
        expect(() => buildUssdString({ network: 'etisalat', phone, amount })).toThrow('رقم سر المحفظة');
        expect(() => buildUssdString({ network: 'orange', phone, amount, pin: '' })).toThrow();
        expect(validateDialInputs({ network: 'we', phone, amount }).code).toBe('PIN_REQUIRED');
        expect(validateDialInputs({ network: 'we', phone, amount, pin: '12' }).code).toBe('INVALID_PIN');
    });

    test('redacts the PIN in debug helpers and never returns plaintext', () => {
        const ussd = buildUssdString({ network: 'orange', phone, amount, pin });
        const redacted = redactUssdForLog(ussd, pin);
        expect(redacted).toContain(PIN_REDACTION_TOKEN);
        expect(redacted).not.toContain(pin);
        expect(ussd).toContain(pin);

        const debug = describeUssdForDebug({
            network: 'etisalat',
            phone,
            amount,
            pin
        });
        expect(JSON.stringify(debug)).not.toContain(pin);
        expect(debug.ussd).toBe('*777*1*[PIN]*250*01108172258*01108172258#');
        expect(debug.pinRequired).toBe(true);
    });

    test('encodes star and hash for tel: URIs and exposes a public state without secrets', () => {
        const ussd = buildUssdString({ network: 'vodafone', phone, amount });
        expect(toTelUri(ussd)).toBe('tel:%2A9%2A7%2A01108172258%2A250%23');
        expect(toTelUri('tel:*9*7*01108172258*250%23')).toBe('tel:%2A9%2A7%2A01108172258%2A250%23');
        expect(normalizeUssdNetwork('WE')).toBe('we');
        expect(PIN_SECURITY_NOTE_AR).toMatch(/رقم سر/);

        const state = toPublicQuickExecuteState(
            { quickExecuteEnabled: true },
            { ussdNetwork: 'etisalat', ussdWalletPinSetAt: new Date(), ussdWalletPinEncrypted: 'iv:cipher:tag' }
        );
        expect(state.enabled).toBe(true);
        expect(state.network).toBe('etisalat');
        expect(state.pinRequired).toBe(true);
        expect(state.pinSet).toBe(true);
        expect(JSON.stringify(state)).not.toContain('iv:cipher:tag');
        expect(state).not.toHaveProperty('pin');
        expect(state.networks).toHaveLength(4);
    });
});
