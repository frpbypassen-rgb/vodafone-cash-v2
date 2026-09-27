'use strict';

// Creates notifications.dedupeKey_1 only. Requires the confirmation flag and
// a duplicate pre-check with zero groups. Not called from startup or deploy.

const {
    assertNotProductionTarget,
    checkNotificationDedupeDuplicates
} = require('./checkNotificationDedupeDuplicates');

const CONFIRM_FLAG = '--confirm-create-notification-dedupe-index';
const INDEX_NAME = 'dedupeKey_1';
const INDEX_KEYS = Object.freeze({ dedupeKey: 1 });
const INDEX_OPTIONS = Object.freeze({ name: INDEX_NAME, unique: true, sparse: true });

const confirmationPresent = (argv = []) => argv.includes(CONFIRM_FLAG);

const createNotificationDedupeIndex = async (db, { confirm = false } = {}) => {
    if (confirm !== true) {
        const error = new Error('CONFIRMATION_REQUIRED');
        error.code = 'CONFIRMATION_REQUIRED';
        throw error;
    }
    const report = await checkNotificationDedupeDuplicates(db);
    if (report.duplicateGroupCount > 0) {
        const error = new Error('DEDUPE_DUPLICATES_PRESENT');
        error.code = 'DEDUPE_DUPLICATES_PRESENT';
        error.report = report;
        throw error;
    }
    const collection = db.collection('notifications');
    let existing = [];
    try {
        existing = await collection.indexes();
    } catch (error) {
        const missing = error && (error.code === 26 || error.codeName === 'NamespaceNotFound');
        if (!missing) throw error;
    }
    const already = existing.find((index) => index.name === INDEX_NAME);
    if (already) {
        return { created: false, alreadyPresent: true, name: INDEX_NAME, report };
    }
    await collection.createIndex(INDEX_KEYS, INDEX_OPTIONS);
    return { created: true, alreadyPresent: false, name: INDEX_NAME, report };
};

const main = async (argv = process.argv.slice(2)) => {
    assertNotProductionTarget();
    if (!confirmationPresent(argv)) {
        const error = new Error('CONFIRMATION_REQUIRED');
        error.code = 'CONFIRMATION_REQUIRED';
        throw error;
    }
    require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });
    assertNotProductionTarget();
    const mongoose = require('mongoose');
    const connectDB = require('../config/database');
    await connectDB();
    try {
        assertNotProductionTarget({ databaseName: mongoose.connection.db.databaseName });
        const result = await createNotificationDedupeIndex(mongoose.connection.db, { confirm: true });
        console.log(JSON.stringify({ ...result, report: undefined, duplicateGroupCount: result.report.duplicateGroupCount }, null, 2));
    } finally {
        await mongoose.disconnect().catch(() => {});
    }
};

if (require.main === module) {
    main().catch((error) => {
        if (error.report) console.error(JSON.stringify(error.report));
        console.error(error.code || error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    CONFIRM_FLAG,
    INDEX_KEYS,
    INDEX_NAME,
    INDEX_OPTIONS,
    confirmationPresent,
    createNotificationDedupeIndex
};
