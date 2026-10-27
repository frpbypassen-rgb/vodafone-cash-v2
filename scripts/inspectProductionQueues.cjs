'use strict';

// Independent read-only process: never imports application services or starts workers.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const inspectRedisQueues = async (redis) => {
    const result = {};
    for (const queue of [
        'api-transfers-queue',
        'notifications-queue',
        'reports-queue',
        'backups-queue',
        'reconciliations-queue',
    ]) {
        const counts = {};
        for (const state of ['active', 'wait'])
            counts[state] = await redis.llen(`bull:${queue}:${state}`);
        for (const state of ['delayed', 'prioritized', 'waiting-children'])
            counts[state] = await redis.zcard(`bull:${queue}:${state}`);
        result[queue] = counts;
    }
    return result;
};

const inspectActiveTransactions = async (collection) => {
    const indexes = await collection.listIndexes().toArray();
    const index = indexes.find(
        (item) => Object.keys(item.key || {})[0] === 'status',
    );
    if (!index) return { skipped: 'NO_STATUS_INDEX' };
    const rows = await collection
        .find(
            {
                status: {
                    $in: [
                        'pending',
                        'processing',
                        'accepted',
                        'deposit_pending',
                    ],
                },
            },
            { projection: { _id: 0, status: 1 } },
        )
        .hint(index.name)
        .limit(101)
        .maxTimeMS(1500)
        .toArray();
    const statuses = {};
    for (const row of rows.slice(0, 100))
        statuses[row.status] = (statuses[row.status] || 0) + 1;
    return {
        sampled: Math.min(rows.length, 100),
        truncated: rows.length > 100,
        statuses,
    };
};

const main = async () => {
    const projectArgument = process.argv.indexOf('--project');
    if (projectArgument < 0 || !process.argv[projectArgument + 1])
        throw new Error('PROJECT_ARGUMENT_REQUIRED');
    const root = fs.realpathSync(process.argv[projectArgument + 1]);
    const localRequire = createRequire(path.join(root, 'package.json'));
    const dotenv = localRequire('dotenv');
    const envPath = path.join(root, '.env');
    const env = {
        ...(fs.existsSync(envPath)
            ? dotenv.parse(fs.readFileSync(envPath))
            : {}),
        ...process.env,
    };
    const report = {
        timestampUtc: new Date().toISOString(),
        readOnly: true,
        warning:
            'Point-in-time sample; zero active jobs does not prove safe worker handoff.',
    };
    let mongo;
    let redis;
    try {
        if (/^mongodb(?:\+srv)?:\/\//.test(env.MONGO_URI || '')) {
            const { MongoClient } = localRequire('mongodb');
            mongo = new MongoClient(env.MONGO_URI, {
                maxPoolSize: 1,
                minPoolSize: 0,
                serverSelectionTimeoutMS: 5000,
                connectTimeoutMS: 5000,
                socketTimeoutMS: 5000,
                retryReads: false,
                retryWrites: false,
            });
            try {
                await mongo.connect();
                const db = mongo.db();
                const hello = await db.command({ hello: 1 });
                report.mongo = {
                    connected: true,
                    topology:
                        hello.msg === 'isdbgrid'
                            ? 'sharded'
                            : hello.setName
                              ? 'replica-set'
                              : 'standalone',
                };
                report.transactions = await inspectActiveTransactions(
                    db.collection('transactions'),
                );
            } catch {
                report.mongoInspection = 'READ_FAILED_OR_NOT_AUTHORIZED';
            }
        } else report.mongoInspection = 'MONGO_URI_NOT_CONFIGURED';

        const redisUrl = env.REDIS_URL || env.REDIS_URI;
        if (redisUrl) {
            const Redis = localRequire('ioredis');
            redis = new Redis(redisUrl, {
                lazyConnect: true,
                enableReadyCheck: false,
                connectTimeout: 3000,
                commandTimeout: 3000,
                maxRetriesPerRequest: 0,
                retryStrategy: () => null,
                reconnectOnError: () => false,
            });
            redis.on('error', () => {});
            try {
                await redis.connect();
                report.queues = await inspectRedisQueues(redis);
            } catch {
                report.redisInspection = 'READ_FAILED_OR_NOT_AUTHORIZED';
            }
        } else report.redisInspection = 'REDIS_URL_NOT_CONFIGURED';
    } finally {
        if (redis) redis.disconnect();
        if (mongo) await mongo.close();
    }
    // Never print connection strings, environment, account IDs, job contents or error messages.
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
};

module.exports = { inspectRedisQueues, inspectActiveTransactions };
if (require.main === module)
    main().catch(() => {
        process.stderr.write(
            'INSPECTION_FAILED: verify project path and installed dependencies. No credentials printed.\n',
        );
        process.exitCode = 1;
    });
