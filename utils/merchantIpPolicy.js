'use strict';
const { isIP, BlockList } = require('node:net');
const invalid = () =>
    Object.assign(
        new Error('أدخل عناوين IPv4 أو IPv6 صحيحة فقط، بحد أقصى 20 عنوانًا.'),
        { code: 'INVALID_IP_LIST', statusCode: 400 },
    );
const normalizeIp = (value) => {
    if (typeof value !== 'string' || value.length > 64) return null;
    const text = value.trim();
    const version = isIP(text);
    if (!version || text.includes('%')) return null;
    if (version === 4) return text;
    const canonical = new URL('http://[' + text + ']/').hostname
        .slice(1, -1)
        .toLowerCase();
    const mapped = canonical.match(/^::ffff:([0-9a-f]+):([0-9a-f]+)$/);
    if (mapped) {
        const a = parseInt(mapped[1], 16),
            b = parseInt(mapped[2], 16);
        return [a >> 8, a & 255, b >> 8, b & 255].join('.');
    }
    return canonical;
};
const parseAddresses = (list) => {
    if (!Array.isArray(list) || list.length > 20) throw invalid();
    const values = list.map(normalizeIp);
    if (values.some((ip) => !ip)) throw invalid();
    return [...new Set(values)];
};
const trustedNetworks = (settings) => {
    if (!Array.isArray(settings) && typeof settings !== 'string') return null;
    const entries = Array.isArray(settings)
        ? settings
        : settings.split(',').map((x) => x.trim());
    const aliases = {
        loopback: ['127.0.0.0/8', '::1/128'],
        linklocal: ['169.254.0.0/16', 'fe80::/10'],
        uniquelocal: [
            '10.0.0.0/8',
            '172.16.0.0/12',
            '192.168.0.0/16',
            'fc00::/7',
        ],
    };
    const block = new BlockList();
    try {
        for (const entry of entries.flatMap((x) => aliases[x] || [x])) {
            const [address, prefix, ...extra] = entry.split('/');
            const ip = normalizeIp(address);
            if (!ip || extra.length) return null;
            if (prefix !== undefined) {
                if (!/^\d+$/.test(prefix) || Number(prefix) < 1) return null;
                block.addSubnet(
                    ip,
                    Number(prefix),
                    isIP(ip) === 4 ? 'ipv4' : 'ipv6',
                );
            } else block.addAddress(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6');
        }
    } catch {
        return null;
    }
    return block;
};
const sourceIp = (req) => {
    const peer = normalizeIp(req.socket?.remoteAddress);
    if (!peer) return null;
    const forwarded = req.headers?.['x-forwarded-for'];
    if (!forwarded) return peer;
    const setting = req.app?.get('trust proxy');
    if (setting === false || setting === 0 || setting === undefined)
        return peer;
    const trusted = trustedNetworks(setting);
    // Hop-count and trust-all configurations cannot distinguish a public direct connection.
    if (!trusted) return null;
    const isTrusted = (ip) =>
        trusted.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6');
    if (!isTrusted(peer)) return peer;
    if (typeof forwarded !== 'string' || forwarded.length > 2048) return null;
    const chain = forwarded.split(',');
    if (chain.length > 20) return null;
    let current = peer;
    for (const raw of chain.reverse()) {
        if (!isTrusted(current)) return current;
        current = normalizeIp(raw);
        if (!current) return null;
    }
    return current;
};
const ipAllowed = (req, entity) => {
    const access = entity.integrationAccess || {};
    if (access.ipAllowlistEnabled !== true) return true;
    const ip = sourceIp(req);
    if (!ip) return false;
    try {
        return parseAddresses(access.allowedIps).includes(ip);
    } catch {
        return false;
    }
};
module.exports = { normalizeIp, parseAddresses, sourceIp, ipAllowed };
