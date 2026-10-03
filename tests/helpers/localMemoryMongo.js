'use strict';

const { URL } = require('url');

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

// Characterization tests may use only the in-memory replica set. A URI is
// accepted only when it is a local single-host MongoDB address.
const assertLocalMemoryMongoUri = (uri) => {
    const value = String(uri || '');
    if (!value.startsWith('mongodb://') || value.includes('mongodb+srv://')) {
        throw new Error('Refusing non-local MongoDB URI');
    }
    let parsed;
    try {
        parsed = new URL(value);
    } catch (_error) {
        throw new Error('Refusing non-local MongoDB URI');
    }
    if (!LOCAL_HOSTS.has(parsed.hostname)) {
        throw new Error('Refusing non-local MongoDB URI');
    }
    return value;
};

const randomDatabaseName = (prefix) => {
    const crypto = require('crypto');
    return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
};

module.exports = {
    assertLocalMemoryMongoUri,
    randomDatabaseName
};
