'use strict';

require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });
const mongoose = require('mongoose');
const connectDB = require('../config/database');
const {
    backfillUnifiedReports,
    getUnifiedReportStatus
} = require('../services/unifiedReportService');

const main = async () => {
    await connectDB();
    const result = await backfillUnifiedReports();
    const status = await getUnifiedReportStatus();
    console.log(JSON.stringify({ success: true, result, status }, null, 2));
};

main()
    .catch((error) => {
        console.error(error.stack || error.message);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect().catch(() => {});
    });
