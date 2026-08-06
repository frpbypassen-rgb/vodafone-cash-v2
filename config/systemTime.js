'use strict';

const SYSTEM_TIME_ZONE = 'Africa/Tripoli';

const applySystemTimeZone = () => {
    process.env.TZ = SYSTEM_TIME_ZONE;
    return SYSTEM_TIME_ZONE;
};

const toValidDate = (value) => {
    const date = value instanceof Date ? new Date(value.getTime()) : new Date(value ?? Date.now());
    return Number.isNaN(date.getTime()) ? null : date;
};

const systemDateParts = (value) => {
    const date = toValidDate(value);
    if (!date) return null;
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: SYSTEM_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date);

    return Object.fromEntries(parts
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]));
};

const systemDateKey = (value) => {
    const parts = systemDateParts(value);
    return parts ? `${parts.year}-${parts.month}-${parts.day}` : '';
};

const systemDayBoundary = (dateValue, endOfDay = false) => {
    const normalized = String(dateValue || '');
    const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(
        Number(match[1]),
        Number(match[2]) - 1,
        Number(match[3]),
        endOfDay ? 23 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 59 : 0,
        endOfDay ? 999 : 0
    );
    return systemDateKey(date) === normalized ? date : null;
};

const systemDayStart = (dateValue) => systemDayBoundary(dateValue, false);
const systemDayEnd = (dateValue) => systemDayBoundary(dateValue, true);

const systemDateRange = (fromDate, toDate) => {
    const range = {};
    const start = systemDayStart(fromDate);
    const end = systemDayEnd(toDate);
    if (start) range.$gte = start;
    if (end) range.$lte = end;
    return Object.keys(range).length ? range : null;
};

const formatSystemDateTime = (value, locale = 'en-GB', options = {}) => {
    const date = toValidDate(value);
    if (!date) return '---';
    return new Intl.DateTimeFormat(locale, {
        timeZone: SYSTEM_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        ...options
    }).format(date);
};

applySystemTimeZone();

module.exports = {
    SYSTEM_TIME_ZONE,
    applySystemTimeZone,
    formatSystemDateTime,
    systemDateRange,
    systemDateKey,
    systemDayEnd,
    systemDayStart,
    systemDateParts,
    toValidDate
};
