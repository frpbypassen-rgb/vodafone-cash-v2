'use strict';

const safeNumber = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
};

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);

const endOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);

const parseLocalDate = (value) => {
    const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(date.getTime()) ? null : date;
};

const resolveDateRange = (query = {}, options = {}) => {
    const now = new Date();
    if (options.forceToday) {
        return {
            start: startOfDay(now),
            end: endOfDay(now),
            from: formatInputDate(now),
            to: formatInputDate(now),
            month: '',
            label: 'اليوم',
        };
    }

    if (query.period === 'today') {
        return {
            start: startOfDay(now),
            end: endOfDay(now),
            from: formatInputDate(now),
            to: formatInputDate(now),
            month: '',
            label: 'اليوم',
        };
    }
    if (query.period === 'week') {
        const end = endOfDay(now);
        const start = startOfDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6));
        return {
            start,
            end,
            from: formatInputDate(start),
            to: formatInputDate(end),
            month: '',
            label: 'آخر 7 أيام',
        };
    }

    const fromDate = parseLocalDate(query.from || query.date);
    const toDate = parseLocalDate(query.to || query.date);
    if (fromDate || toDate) {
        const start = startOfDay(fromDate || toDate);
        const end = endOfDay(toDate || fromDate);
        return {
            start: start <= end ? start : startOfDay(end),
            end: start <= end ? end : endOfDay(start),
            from: formatInputDate(start <= end ? start : end),
            to: formatInputDate(start <= end ? end : start),
            month: '',
            label: formatRangeLabel(start <= end ? start : end, start <= end ? end : start),
        };
    }

    const monthMatch = String(query.month || '').match(/^(\d{4})-(\d{2})$/);
    const year = monthMatch ? Number(monthMatch[1]) : now.getFullYear();
    const monthIndex = monthMatch ? Number(monthMatch[2]) - 1 : now.getMonth();
    const start = new Date(year, monthIndex, 1, 0, 0, 0, 0);
    const end = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
    return {
        start,
        end,
        from: '',
        to: '',
        month: `${year}-${String(monthIndex + 1).padStart(2, '0')}`,
        label: `شهر ${monthIndex + 1} / ${year}`,
    };
};

function formatInputDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatRangeLabel(start, end) {
    if (formatInputDate(start) === formatInputDate(end)) return formatInputDate(start);
    return `${formatInputDate(start)} - ${formatInputDate(end)}`;
}

module.exports = {
    safeNumber,
    escapeRegex,
    startOfDay,
    endOfDay,
    parseLocalDate,
    resolveDateRange,
    formatInputDate,
    formatRangeLabel,
};
