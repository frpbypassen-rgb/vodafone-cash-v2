'use strict';

const net = require('net');

// Normalise only literal IP addresses. Host names are intentionally rejected:
// DNS may change after approval, while an IP allow-list stays deterministic.
const normalizeSourceIp = (value) => {
    let ip = String(value || '').trim().toLowerCase();
    if (!ip) return '';
    if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    return net.isIP(ip) ? ip : '';
};

const requestSourceIp = (req) => normalizeSourceIp(
    req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress
);

const activeLockedServer = (company) => {
    const policy = company?.apiAccessPolicy || {};
    if (policy.mode !== 'locked') return null;
    return (policy.servers || []).find((server) => (
        String(server?._id || '') === String(policy.lockedServerId || '')
        && server.enabled !== false
    )) || null;
};

const authorizeCompanyApiServer = ({ company, req }) => {
    const policy = company?.apiAccessPolicy || {};
    const sourceIp = requestSourceIp(req);
    if (policy.mode !== 'locked') {
        return { allowed: true, sourceIp, server: null };
    }

    const server = activeLockedServer(company);
    if (!server) {
        return {
            allowed: false,
            sourceIp,
            code: 'API_SERVER_LOCK_MISCONFIGURED',
            message: 'قفل خادم API غير مكتمل. تواصل مع إدارة الحساب.'
        };
    }
    if (!sourceIp || sourceIp !== normalizeSourceIp(server.sourceIp)) {
        return {
            allowed: false,
            sourceIp,
            code: 'API_SERVER_NOT_ALLOWED',
            message: 'هذا الخادم غير مصرح له بإرسال طلبات API لهذا الحساب.'
        };
    }

    return { allowed: true, sourceIp, server };
};

module.exports = {
    normalizeSourceIp,
    requestSourceIp,
    activeLockedServer,
    authorizeCompanyApiServer
};
