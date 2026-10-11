'use strict';
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });
const mongoose = require('mongoose');
const TelegramAccountLink = require('../models/TelegramAccountLink');
const connectDB = require('../config/database');

(async () => {
    await connectDB();
    const collection = TelegramAccountLink.collection;
    const indexes = await collection.indexes();
    const legacy = indexes.find((index) => index.name === 'ownerModel_1_ownerId_1' && index.unique);
    if (legacy) await collection.dropIndex(legacy.name);
    await collection.createIndex({ ownerModel: 1, ownerId: 1 });
    console.log(JSON.stringify({ success: true, droppedLegacyUniqueIndex: Boolean(legacy) }));
    await mongoose.disconnect();
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
