'use strict';
const { isIP } = require('node:net');
const native = require('express-rate-limit');

// Only limiter keys are normalized. Do not mutate req.ip, headers or device/session identity.
const normalizeRateLimitIp = (value) => {
    const raw = String(value || '').trim();
    if (isIP(raw)) {
        const mapped = /^::ffff:(.+)$/i.exec(raw);
        return mapped && isIP(mapped[1]) === 4 ? mapped[1] : raw;
    }
    const endpoint =
        /^(?:\[([^\]]+)\]|(\d{1,3}(?:\.\d{1,3}){3})):(\d{1,5})$/.exec(raw);
    if (!endpoint || Number(endpoint[3]) > 65535) return '';
    const address = endpoint[1] || endpoint[2];
    return isIP(address) ? normalizeRateLimitIp(address) : '';
};

const rateLimit = (options = {}) => {
    if (options.keyGenerator !== undefined) return native(options);
    const { ipv6Subnet = 56, ...rest } = options;
    return native({
        ...rest,
        keyGenerator: async (req, res) => {
            // Express has already selected the IP using its trust-proxy policy. Never read XFF directly.
            const ip =
                normalizeRateLimitIp(req.ip) ||
                normalizeRateLimitIp(req.socket?.remoteAddress);
            if (!ip) return 'invalid-client-address';
            const subnet =
                typeof ipv6Subnet === 'function'
                    ? await ipv6Subnet(req, res)
                    : ipv6Subnet;
            return native.ipKeyGenerator(ip, subnet);
        },
    });
};
module.exports = Object.assign(rateLimit, { rateLimit, normalizeRateLimitIp });
