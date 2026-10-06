'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { inspectExecutorReadiness } = require('../services/executorReadinessService');

async function main() {
    let connection;
    try {
        const envPath = path.resolve(process.argv[2] || '.env');
        if (fs.existsSync(envPath)) {
            const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
            for (const [key, value] of Object.entries(parsed)) {
                if (process.env[key] === undefined) process.env[key] = value;
            }
        }
        const mongoUri = String(process.env.MONGO_URI || '').trim();
        if (!mongoUri) {
            console.error('Executor readiness: MONGO_URI is missing.');
            process.exitCode = 2;
            return;
        }

        // No models are registered: this probe cannot create or synchronize indexes.
        connection = mongoose.createConnection(mongoUri, {
            autoIndex: false,
            autoCreate: false,
            serverSelectionTimeoutMS: 10000,
            connectTimeoutMS: 10000
        });
        await connection.asPromise();
        const report = await inspectExecutorReadiness(connection);
        console.log(JSON.stringify(report, null, 2));
        if (!report.ready) process.exitCode = 1;
    } catch (error) {
        console.error(JSON.stringify({ ready: false, code: 'EXECUTOR_READINESS_FAILED', errorType: error.constructor?.name || 'Error' }));
        process.exitCode = 1;
    } finally {
        try {
            await connection?.close();
        } catch (error) {
            console.error(JSON.stringify({ ready: false, code: 'EXECUTOR_READINESS_CLOSE_FAILED', errorType: error.constructor?.name || 'Error' }));
            process.exitCode = 1;
        }
    }
}

if (require.main === module) main();

module.exports = { main };
