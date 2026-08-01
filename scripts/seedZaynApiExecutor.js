'use strict';

require('dotenv').config();

const mongoose = require('mongoose');
const ExecutorGroup = require('../models/ExecutorGroup');
const { DEFAULT_API_PROVIDER_KEY, getApiProviderPreset } = require('../utils/apiProviderPresets');

const required = (value, label) => {
    const clean = String(value || '').trim();
    if (!clean) {
        throw new Error(`Missing required value: ${label}`);
    }
    return clean;
};

async function main() {
    const mongoUri = required(process.env.MONGO_URI, 'MONGO_URI');
    const apiUsername = required(process.env.ZAYN_EXECUTOR_USERNAME || process.env.ZAYN_USERNAME, 'ZAYN_EXECUTOR_USERNAME');
    const apiPassword = required(process.env.ZAYN_EXECUTOR_PASSWORD || process.env.ZAYN_PASSWORD, 'ZAYN_EXECUTOR_PASSWORD');
    const apiProviderKey = process.env.ZAYN_EXECUTOR_PROVIDER_KEY || DEFAULT_API_PROVIDER_KEY;
    const preset = getApiProviderPreset(apiProviderKey);

    await mongoose.connect(mongoUri, { retryWrites: false });

    const botName = process.env.ZAYN_EXECUTOR_NAME || 'Zayn External Aggregator';
    const bot = await ExecutorGroup.findOneAndUpdate(
        {
            isApiBot: true,
            apiProviderKey: preset.key,
            apiUsername
        },
        {
            $set: {
                name: botName,
                status: 'active',
                isApiGroup: true,
                isApiBot: true,
                isManagerGroup: false,
                isManagerBot: false,
                parentGroupId: null,
                parentBotId: null,
                apiProviderKey: preset.key,
                apiUrl: process.env.ZAYN_EXECUTOR_API_URL || preset.apiUrl,
                apiUsername,
                apiPassword,
                apiServiceId: Number(process.env.ZAYN_EXECUTOR_SERVICE_ID || preset.serviceId),
                apiProviderId: Number(process.env.ZAYN_EXECUTOR_PROVIDER_ID || preset.providerId),
                apiFieldId: Number(process.env.ZAYN_EXECUTOR_FIELD_ID || preset.fieldId),
                apiMachineSerial: process.env.ZAYN_EXECUTOR_MACHINE_SERIAL || preset.machineSerial
            },
            $setOnInsert: {
                balance: 0
            }
        },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );

    console.log(`تم تجهيز منفذ API: ${bot.name}`);
    console.log(`Provider: ${bot.apiProviderKey}`);
    console.log(`Executor ID: ${bot._id}`);
}

main()
    .catch((error) => {
        console.error(`فشل تجهيز منفذ API: ${error.message}`);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect().catch(() => {});
    });
