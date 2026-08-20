const normalizeTrustedProxyHttps = ({ enabled = false } = {}) => (req, _res, next) => {
    if (enabled && !req.headers['x-forwarded-proto']) {
        // Plesk/ARR may terminate TLS without forwarding the original protocol.
        req.headers['x-forwarded-proto'] = 'https';
    }
    next();
};

module.exports = { normalizeTrustedProxyHttps };
