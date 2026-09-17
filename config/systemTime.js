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

const validCalendarDate = (year, month, day) => {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
        && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day;
};

// Convert a wall-clock value in SYSTEM_TIME_ZONE to an absolute instant. This
// deliberately avoids the process-local timezone because changing TZ at
// runtime is not consistently honoured on Windows.
const zonedDateTime = ({ year, month, day, hour = 0, minute = 0, second = 0, millisecond = 0 }) => {
    const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
    let instant = targetAsUtc;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const parts = systemDateParts(new Date(instant));
        if (!parts) return null;
        const representedAsUtc = Date.UTC(
            Number(parts.year), Number(parts.month) - 1, Number(parts.day),
            Number(parts.hour), Number(parts.minute), Number(parts.second), millisecond
        );
        const correction = targetAsUtc - representedAsUtc;
        if (!correction) break;
        instant += correction;
    }
    return new Date(instant);
};

const systemDayBoundary = (dateValue, endOfDay = false) => {
    const normalized = String(dateValue || '');
    const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!validCalendarDate(year, month, day)) return null;
    const date = zonedDateTime({
        year, month, day,
        hour: endOfDay ? 23 : 0,
        minute: endOfDay ? 59 : 0,
        second: endOfDay ? 59 : 0,
        millisecond: endOfDay ? 999 : 0
    });
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
    zonedDateTime,
    applySystemTimeZone,
    formatSystemDateTime,
    systemDateRange,
    systemDateKey,
    systemDayEnd,
    systemDayStart,
    systemDateParts,
    toValidDate
};
