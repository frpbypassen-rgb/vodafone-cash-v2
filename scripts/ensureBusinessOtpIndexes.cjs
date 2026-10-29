'use strict';
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env', quiet: true });
const mongoose = require('mongoose');
const main = async () => {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI_REQUIRED');
    try {
        await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, serverSelectionTimeoutMS: 15000 });
        await require('../models/BusinessLoginChallenge').createIndexes();
        console.log(JSON.stringify({ ready: true, collection: 'businessloginchallenges', ttlSeconds: 0 }));
    } finally { await mongoose.disconnect(); }
};
main().catch(() => { console.error('BUSINESS_OTP_INDEX_SETUP_FAILED'); process.exitCode = 1; });
