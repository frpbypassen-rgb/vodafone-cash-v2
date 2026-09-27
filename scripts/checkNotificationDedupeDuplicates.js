'use strict';

// Read-only. This script aggregates notifications and does not insert, update,
// delete, or create indexes.

const {
    databaseNameFromUri,
    deniedDatabaseNames,
    isProductionAppDir,
    isProductionPm2Name
} = require('./checkStagingReadiness');

const PM2_ENV_KEYS = ['PM2_NAME', 'PM2_APP_NAME', 'name'];
const SAMPLE_LIMIT = 5;

const productionTargetRefusals = ({
    env = process.env,
    cwd = process.cwd(),
    processTitle = process.title,
    databaseName = ''
} = {}) => {
    const reasons = [];
    PM2_ENV_KEYS.forEach((key) => {
        if (isProductionPm2Name(env[key])) reasons.push(`env ${key} is the production process`);
    });
    if (isProductionPm2Name(processTitle)) reasons.push('process title is the production process');
    if (isProductionAppDir(env.APP_DIR)) reasons.push('APP_DIR is the production path');
    if (isProductionAppDir(cwd)) reasons.push('working directory is the production path');
    const fromUri = databaseNameFromUri(env.MONGO_URI || '');
    const names = [databaseName, fromUri.name].map((name) => String(name || '').trim()).filter(Boolean);
    const denied = deniedDatabaseNames({ env, processEnv: env });
    names.forEach((name) => {
        if (denied.has(name.toLowerCase())) reasons.push(`database ${name} is denied`);
    });
    return reasons;
};

const assertNotProductionTarget = (options) => {
    const reasons = productionTargetRefusals(options);
    if (!reasons.length) return;
    const error = new Error(`PRODUCTION_TARGET_REFUSED: ${reasons.join('; ')}`);
    error.code = 'PRODUCTION_TARGET_REFUSED';
    error.reasons = reasons;
    throw error;
};

const checkNotificationDedupeDuplicates = async (db) => {
    const grouped = await db.collection('notifications').aggregate([
        { $match: { dedupeKey: { $type: 'string', $gt: '' } } },
        {
            $group: {
                _id: '$dedupeKey',
                count: { $sum: 1 },
                sampleIds: { $push: '$_id' }
            }
        }
    ]).toArray();
    const duplicateGroups = grouped
        .filter((group) => group.count > 1)
        .map((group) => ({
            dedupeKey: group._id,
            count: group.count,
            sampleIds: (group.sampleIds || []).slice(0, SAMPLE_LIMIT).map((id) => String(id))
        }));
    return {
        readOnly: true,
        writes: 0,
        notificationsWithDedupeKey: grouped.reduce((sum, group) => sum + group.count, 0),
        duplicateGroupCount: duplicateGroups.length,
        duplicateGroups
    };
};

const main = async () => {
    assertNotProductionTarget();
    require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });
    assertNotProductionTarget();
    const mongoose = require('mongoose');
    const connectDB = require('../config/database');
    await connectDB();
    try {
        assertNotProductionTarget({ databaseName: mongoose.connection.db.databaseName });
        const report = await checkNotificationDedupeDuplicates(mongoose.connection.db);
        console.log(JSON.stringify(report, null, 2));
    } finally {
        await mongoose.disconnect().catch(() => {});
    }
};

if (require.main === module) {
    main().catch((error) => {
        console.error(error.code || error.message);
        process.exitCode = 1;
    });
}

module.exports = {
    SAMPLE_LIMIT,
    assertNotProductionTarget,
    checkNotificationDedupeDuplicates,
    productionTargetRefusals
};
