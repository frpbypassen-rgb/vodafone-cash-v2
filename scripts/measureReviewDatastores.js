'use strict';

/**
 * Measures the review environment only. Not Staging and not Production.
 * Starts an in-memory MongoDB replica set, pings a local Redis, and releases
 * one probe lock. Writes versions to docs/financial-safety/review-environment-measurement.json.
 */

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const Redis = require('ioredis');

mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);

const main = async () => {
    const redisUrl = process.env.REVIEW_REDIS_URL;
    const replset = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    const report = {
        scope: 'review-environment-only',
        stagingMeasured: false,
        productionMeasured: false,
        node: process.version,
        mongodbMemoryServer: require('mongodb-memory-server/package.json').version
    };
    try {
        await mongoose.connect(replset.getUri(), { autoIndex: false, autoCreate: false });
        const build = await mongoose.connection.db.admin().command({ buildInfo: 1 });
        const hello = await mongoose.connection.db.admin().command({ hello: 1 });
        report.mongo = {
            version: build.version,
            storageEngine: 'wiredTiger',
            replSetMembers: 1,
            setNamePresent: Boolean(hello.setName),
            msg: hello.msg || '',
            transactionsCapable: Boolean(hello.setName) || hello.msg === 'isdbgrid'
        };
    } finally {
        await mongoose.disconnect().catch(() => {});
        await replset.stop();
    }

    if (!redisUrl) {
        report.redis = { measured: false, reason: 'REVIEW_REDIS_URL was not set' };
    } else {
        const client = new Redis(redisUrl, { maxRetriesPerRequest: 1, connectTimeout: 3000, lazyConnect: true });
        client.on('error', () => {});
        try {
            await client.connect();
            const ping = await client.ping();
            const info = await client.info('server');
            const RedlockClass = require('redlock').default || require('redlock');
            const redlock = new RedlockClass([client], { retryCount: 2, retryDelay: 50, retryJitter: 0 });
            const lock = await redlock.acquire(['locks:financial-safety-readonly-probe'], 5000);
            await lock.release();
            report.redis = {
                measured: true,
                ping,
                version: (String(info).match(/redis_version:([^\r\n]+)/) || [])[1] || '',
                redlock: JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'redlock', 'package.json'), 'utf8')).version,
                probeReleased: true
            };
        } finally {
            await client.quit().catch(() => {});
        }
    }

    const file = path.join(__dirname, '..', 'docs', 'financial-safety', 'review-environment-measurement.json');
    fs.writeFileSync(file, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
};

main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
});
