'use strict';
const { isIP } = require('node:net');
const readTrustProxy = (env = process.env) => {
    const value = String(env.TRUST_PROXY || '').trim();
    if (!value) return 1; // Existing deployment behavior until the actual proxy chain is inventoried.
    if (value === 'false' || value === '0') return false;
    if (/^\d+$/.test(value) && Number(value) <= 32) return Number(value);
    const networks = value.split(',').map((part) => part.trim());
    const valid = networks.every((network) => {
        if (['loopback', 'linklocal', 'uniquelocal'].includes(network))
            return true;
        const [ip, prefix, ...extra] = network.split('/');
        const version = isIP(ip);
        if (!version || extra.length) return false;
        return (
            prefix === undefined ||
            (/^\d+$/.test(prefix) &&
                Number(prefix) > 0 &&
                Number(prefix) <= (version === 4 ? 32 : 128))
        );
    });
    if (!valid)
        throw new Error(
            'TRUST_PROXY must name explicit trusted networks, false, or 1–32 proxy hops.',
        );
    return networks;
};
module.exports = { readTrustProxy };
