'use strict';

const isPlainObject = (value) => (
    Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(value instanceof Date)
);

const hasOperator = (predicate) => (
    isPlainObject(predicate) && Object.keys(predicate).some((key) => key.startsWith('$'))
);

const fieldMatches = (value, predicate) => {
    if (!hasOperator(predicate)) {
        return value === predicate || (value == null && predicate == null)
            || String(value) === String(predicate);
    }
    return Object.entries(predicate).every(([operator, expected]) => {
        if (operator === '$eq') return fieldMatches(value, expected);
        if (operator === '$in') return expected.some((item) => fieldMatches(value, item));
        if (operator === '$nin') return !expected.some((item) => fieldMatches(value, item));
        if (operator === '$ne') return !fieldMatches(value, expected);
        if (operator === '$exists') {
            const exists = value !== undefined && value !== null;
            return expected ? exists : !exists;
        }
        if (operator === '$gte') return new Date(value).getTime() >= new Date(expected).getTime();
        if (operator === '$lte') return new Date(value).getTime() <= new Date(expected).getTime();
        return false;
    });
};

const mongoQueryMatches = (doc, query = {}) => {
    if (!query || typeof query !== 'object') return true;
    return Object.entries(query).every(([key, predicate]) => {
        if (key === '$and') return predicate.every((item) => mongoQueryMatches(doc, item));
        if (key === '$or') return predicate.some((item) => mongoQueryMatches(doc, item));
        if (key === '$nor') return predicate.every((item) => !mongoQueryMatches(doc, item));
        return fieldMatches(doc[key], predicate);
    });
};

module.exports = { mongoQueryMatches };
