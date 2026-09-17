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
    
    // Libya uses UTC+2 (Africa/Tripoli timezone)
    // Midnight in Libya = 22:00 UTC previous day
    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    
    if (endOfDay) {
        // End of day: next day at midnight (Libya time) = next day -2 hours UTC
        const date = new Date(Date.UTC(year, month, day + 1, -2, 0, 0, -1));
        return systemDateKey(date) === normalized ? date : null;
    } else {
        // Start of day: current day at midnight (Libya time) = current day -2 hours UTC
        const date = new Date(Date.UTC(year, month, day, -2, 0, 0, 0));
        return systemDateKey(date) === normalized ? date : null;
    }
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
