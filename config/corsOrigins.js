'use strict';

const DEFAULT_LOCAL_ORIGINS = [
    'http://localhost:3000',
    'http://127.0.0.1:3000'
];

// Flutter's web-server preview is intentionally limited to these loopback origins.
const MOBILE_WEB_PREVIEW_ORIGINS = [
    'http://localhost:3001',
    'http://127.0.0.1:3001'
];

function parseOrigins(value) {
    if (!value) return [];

    return value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean);
}

function getAllowedOrigins(configuredOrigins = process.env.ALLOWED_ORIGINS) {
    const configured = parseOrigins(configuredOrigins);
    return [...new Set(configured.length ? configured : DEFAULT_LOCAL_ORIGINS)];
}

function getMobileAllowedOrigins(configuredOrigins = process.env.ALLOWED_ORIGINS) {
    return [...new Set([
        ...getAllowedOrigins(configuredOrigins),
        ...MOBILE_WEB_PREVIEW_ORIGINS
    ])];
}

module.exports = {
    DEFAULT_LOCAL_ORIGINS,
    MOBILE_WEB_PREVIEW_ORIGINS,
    getAllowedOrigins,
    getMobileAllowedOrigins
};
