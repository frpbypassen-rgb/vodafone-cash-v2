'use strict';
const {
    normalizeIp,
    parseAddresses,
    sourceIp,
    ipAllowed,
} = require('../utils/merchantIpPolicy');
const request = (socket, xff, trust = false) => ({
    socket: { remoteAddress: socket },
    headers: xff ? { 'x-forwarded-for': xff } : {},
    app: { get: () => trust },
});
test('accepts exact IPv4/IPv6, normalizes mapped addresses and rejects networks/hosts/ports', () => {
    expect(normalizeIp('::ffff:192.0.2.1')).toBe('192.0.2.1');
    expect(normalizeIp('2001:0db8:0:0:0:0:0:1')).toBe('2001:db8::1');
    expect(parseAddresses(['192.0.2.1', '::ffff:192.0.2.1'])).toEqual([
        '192.0.2.1',
    ]);
    for (const invalid of [
        'example.com',
        '192.0.2.1/24',
        'https://192.0.2.1',
        '192.0.2.1:443',
        '012.0.0.1',
        'fe80::1%eth0',
    ])
        expect(() => parseAddresses([invalid])).toThrow();
    expect(() => parseAddresses(Array(21).fill('192.0.2.1'))).toThrow();
});
test('untrusted clients cannot spoof headers; explicit proxy networks resolve nearest untrusted peer', () => {
    expect(sourceIp(request('198.51.100.2', '192.0.2.1', ['loopback']))).toBe(
        '198.51.100.2',
    );
    expect(
        sourceIp(request('127.0.0.1', '192.0.2.1, 198.51.100.2', ['loopback'])),
    ).toBe('198.51.100.2');
    expect(sourceIp(request('127.0.0.1', '192.0.2.1', 1))).toBeNull();
    expect(sourceIp(request('127.0.0.1', 'invalid', ['loopback']))).toBeNull();
    expect(sourceIp(request('::ffff:192.0.2.1'))).toBe('192.0.2.1');
});
test('disabled policy preserves access; enabled empty/invalid policy fails closed', () => {
    const req = request('::ffff:192.0.2.1');
    expect(ipAllowed(req, { integrationAccess: {} })).toBe(true);
    expect(
        ipAllowed(req, {
            integrationAccess: { ipAllowlistEnabled: true, allowedIps: [] },
        }),
    ).toBe(false);
    expect(
        ipAllowed(req, {
            integrationAccess: {
                ipAllowlistEnabled: true,
                allowedIps: ['192.0.2.1'],
            },
        }),
    ).toBe(true);
    expect(
        ipAllowed(request('198.51.100.2', '192.0.2.1'), {
            integrationAccess: {
                ipAllowlistEnabled: true,
                allowedIps: ['192.0.2.1'],
            },
        }),
    ).toBe(false);
});
