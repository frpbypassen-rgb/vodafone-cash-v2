'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

const envPath = path.resolve(process.argv[2] || '.env');

if (fs.existsSync(envPath)) {
    const parsed = dotenv.parse(fs.readFileSync(envPath, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
        if (process.env[key] === undefined) process.env[key] = value;
    }
}

const mongoUri = String(process.env.MONGO_URI || '').trim();

if (!mongoUri) {
    console.error('[ERROR] MONGO_URI is missing.');
    process.exit(2);
}

async function main() {
    let session;

    try {
        await mongoose.connect(mongoUri, {
            retryWrites: false,
            serverSelectionTimeoutMS: 10000,
            connectTimeoutMS: 10000,
            heartbeatFrequencyMS: 10000
        });

        const hello = await mongoose.connection.db.admin().command({ hello: 1 });
        const topology = hello.msg === 'isdbgrid'
            ? 'sharded-cluster'
            : hello.setName
                ? `replica-set:${hello.setName}`
                : 'standalone';

        if (topology === 'standalone') {
            throw Object.assign(
                new Error('MongoDB is running as standalone; financial transactions require a replica set or sharded cluster.'),
                { code: 'MONGO_TRANSACTIONS_UNSUPPORTED' }
            );
        }

        session = await mongoose.startSession();
        session.startTransaction({
            readConcern: { level: 'snapshot' },
            writeConcern: { w: 'majority' }
        });

        await mongoose.connection.db
            .collection('tenants')
            .findOne({}, { projection: { _id: 1 }, session });
        await session.abortTransaction();

        console.log('MongoDB transaction preflight');
        console.log(`Topology: ${topology}`);
        console.log('Read-only transaction probe: PASSED');
    } catch (error) {
        if (session?.inTransaction()) {
            await session.abortTransaction().catch(() => {});
        }
        console.error('MongoDB transaction preflight: FAILED');
        console.error(`Code: ${error.code || 'MONGO_TRANSACTION_PREFLIGHT_FAILED'}`);
        console.error(`Reason: ${error.message}`);
        process.exitCode = 1;
    } finally {
        await session?.endSession().catch(() => {});
        await mongoose.disconnect().catch(() => {});
    }
}

main();
