'use strict';

const UNKNOWN_COUNTRY_CODES = new Set(['', 'XX', 'T1', 'A1', 'A2', 'O1']);

const extractRequestCountry = (req) => {
    if (!req || !req.headers) return '';
    const raw = String(
        req.headers['cf-ipcountry']
        || req.headers['x-country-code']
        || req.headers['x-geo-country']
        || ''
    ).trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(raw) || UNKNOWN_COUNTRY_CODES.has(raw)) return '';
    return raw;
};

const applyRequestGeo = (target, req) => {
    const country = extractRequestCountry(req);
    if (country && target && typeof target === 'object') target.originCountry = country;
    return country;
};

module.exports = {
    applyRequestGeo,
    extractRequestCountry,
    UNKNOWN_COUNTRY_CODES
};
