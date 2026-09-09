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

const firstForwardedIp = (value) => String(value || '').split(',')[0].trim();

// Merchant requests may pass through Cloudflare or a reverse proxy. In that
// case Express can otherwise see the proxy address instead of the partner's
// public server IP. These headers must only be forwarded by the deployment
// proxy; the production proxy is responsible for stripping client-supplied
// copies before it forwards traffic to Node.
const requestSourceIp = (req) => {
    const headers = req?.headers || {};
    const candidates = [
        headers['cf-connecting-ip'],
        headers['x-real-ip'],
        firstForwardedIp(headers['x-forwarded-for']),
        req?.ip,
        req?.socket?.remoteAddress,
        req?.connection?.remoteAddress
    ];
    return candidates.map(normalizeSourceIp).find(Boolean) || '';
};

const serverForSourceIp = (company, sourceIp) => {
    const normalizedIp = normalizeSourceIp(sourceIp);
    return (company?.apiAccessPolicy?.servers || []).find((server) => (
        normalizeSourceIp(server?.sourceIp) === normalizedIp
    )) || null;
};

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
    const sourceServer = serverForSourceIp(company, sourceIp);
    if (sourceServer?.enabled === false) {
        return {
            allowed: false,
            sourceIp,
            server: sourceServer,
            code: 'API_SERVER_SUSPENDED',
            message: 'تم تعليق مصدر API هذا لهذا الحساب.'
        };
    }
    if (policy.mode !== 'locked') {
        return { allowed: true, sourceIp, server: sourceServer };
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
    serverForSourceIp,
    activeLockedServer,
    authorizeCompanyApiServer
};
