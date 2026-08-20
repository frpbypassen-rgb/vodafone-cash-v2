'use strict';

const crypto = require('crypto');

const normalizeIp = (value) => String(value || '')
    .trim()
    .replace(/^\[|\]$/g, '')
    .replace(/^::ffff:/i, '');

const isLoopbackIp = (value) => {
    const ip = normalizeIp(value);
    return ip === '127.0.0.1' || ip === '::1';
};

const getNearestForwardedIp = (headers = {}) => {
    const forwarded = String(headers['x-forwarded-for'] || '')
        .split(',')
        .map(normalizeIp)
        .filter(Boolean);
    return forwarded.length ? forwarded[forwarded.length - 1] : '';
};

const resolveClientIp = ({ headers = {}, peerAddress = '' } = {}) => {
    const peerIp = normalizeIp(peerAddress);
    if (!isLoopbackIp(peerIp)) return peerIp;
    return getNearestForwardedIp(headers) || peerIp;
};

const requestClientIp = (req) => resolveClientIp({
    headers: req.headers,
    peerAddress: req.socket?.remoteAddress || req.connection?.remoteAddress || req.ip
});

const socketClientIp = (socket) => resolveClientIp({
    headers: socket.handshake?.headers || socket.request?.headers,
    peerAddress: socket.request?.socket?.remoteAddress || socket.handshake?.address
});

const safeTokenEqual = (left, right) => {
    const leftBuffer = Buffer.from(String(left || ''));
    const rightBuffer = Buffer.from(String(right || ''));
    return leftBuffer.length > 0
        && leftBuffer.length === rightBuffer.length
        && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const readBearerToken = (authorization) => {
    const match = /^Bearer\s+(.+)$/i.exec(String(authorization || '').trim());
    return match ? match[1].trim() : '';
};

const requestOperationalToken = (req) => (
    readBearerToken(req.headers.authorization)
    || String(req.headers['x-operational-token'] || '').trim()
);

const socketOperationalToken = (socket) => (
    String(socket.handshake?.auth?.token || '').trim()
    || readBearerToken(socket.handshake?.headers?.authorization)
);

const hasOperationalAccess = ({ clientIp, suppliedToken, expectedToken }) => (
    isLoopbackIp(clientIp) || safeTokenEqual(suppliedToken, expectedToken)
);

const requireOperationalAccess = ({ tokenEnv, deniedMessage = 'Forbidden' }) => (req, res, next) => {
    const allowed = hasOperationalAccess({
        clientIp: requestClientIp(req),
        suppliedToken: requestOperationalToken(req),
        expectedToken: process.env[tokenEnv]
    });

    if (allowed) return next();
    res.set('Cache-Control', 'no-store');
    res.set('WWW-Authenticate', 'Bearer');
    return res.status(403).send(deniedMessage);
};

const isAuthorizedOperationalSocket = (socket, tokenEnv) => hasOperationalAccess({
    clientIp: socketClientIp(socket),
    suppliedToken: socketOperationalToken(socket),
    expectedToken: process.env[tokenEnv]
});

module.exports = {
    hasOperationalAccess,
    isAuthorizedOperationalSocket,
    isLoopbackIp,
    requestClientIp,
    requireOperationalAccess,
    resolveClientIp,
    safeTokenEqual,
    socketClientIp
};
