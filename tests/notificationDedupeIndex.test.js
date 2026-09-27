'use strict';

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

mongoose.set('autoIndex', true);
mongoose.set('autoCreate', true);

const Notification = require('../models/Notification');
const { recordInAppNotification } = require('../services/bullQueueService');
const {
    assertNotProductionTarget,
    checkNotificationDedupeDuplicates,
    productionTargetRefusals
} = require('../scripts/checkNotificationDedupeDuplicates');
const {
    CONFIRM_FLAG,
    INDEX_NAME,
    confirmationPresent,
    createNotificationDedupeIndex
} = require('../scripts/createNotificationDedupeIndex');

jest.setTimeout(180000);

let replSet;

const dedupeIndexes = async () => {
    const indexes = await Notification.collection.indexes();
    return indexes.filter((index) => index.key && index.key.dedupeKey === 1);
};

beforeAll(async () => {
    mongoose.set('autoIndex', true);
    Notification.schema.set('autoIndex', true);
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(replSet.getUri());
    await Notification.init();
    await Notification.createIndexes();
    await Notification.syncIndexes();
});

afterAll(async () => {
    await mongoose.disconnect();
    if (replSet) await replSet.stop();
});

describe('notification dedupe index is not created automatically', () => {
    test('the schema and startup index paths do not build dedupeKey_1', async () => {
        const declared = Notification.schema.indexes().some(([fields]) => Object.prototype.hasOwnProperty.call(fields, 'dedupeKey'));
        expect(declared).toBe(false);
        expect(await dedupeIndexes()).toHaveLength(0);

        const roots = ['models', 'services', 'scripts', 'config', 'utils', 'routes', 'controllers', 'app.js'];
        const offenders = [];
        const visit = (target) => {
            if (!fs.existsSync(target)) return;
            const stat = fs.statSync(target);
            if (stat.isDirectory()) {
                fs.readdirSync(target).forEach((entry) => visit(path.join(target, entry)));
                return;
            }
            if (!target.endsWith('.js')) return;
            if (target.endsWith(`${path.sep}scripts${path.sep}createNotificationDedupeIndex.js`)) return;
            const source = fs.readFileSync(target, 'utf8');
            if (/schema\.index\(\s*\{\s*dedupeKey|createIndex\(\s*\{\s*dedupeKey|ensureIndexes\(\s*\)|Notification\.syncIndexes\(/.test(source)) {
                offenders.push(path.relative(process.cwd(), target));
            }
        };
        roots.forEach((root) => visit(path.join(process.cwd(), root)));
        expect(offenders).toEqual([]);
    });

    test('the pre-check only aggregates and the create script refuses production targets and a missing flag', async () => {
        await Notification.create({ title: 'plain', message: 'no key' });
        await Notification.create({ title: 'one', message: 'a', dedupeKey: 'seq-a' });
        await Notification.collection.insertMany([
            { title: 'dup', message: 'b', dedupeKey: 'dup-key', isRead: false },
            { title: 'dup', message: 'c', dedupeKey: 'dup-key', isRead: false }
        ]);
        const before = await Notification.countDocuments();
        const report = await checkNotificationDedupeDuplicates(mongoose.connection.db);
        expect(report).toEqual(expect.objectContaining({
            readOnly: true,
            writes: 0,
            notificationsWithDedupeKey: 3,
            duplicateGroupCount: 1
        }));
        expect(report.duplicateGroups[0].dedupeKey).toBe('dup-key');
        expect(report.duplicateGroups[0].count).toBe(2);
        expect(report.duplicateGroups[0].sampleIds).toHaveLength(2);
        expect(await Notification.countDocuments()).toBe(before);
        expect(await dedupeIndexes()).toHaveLength(0);

        await expect(createNotificationDedupeIndex(mongoose.connection.db, { confirm: true }))
            .rejects.toMatchObject({ code: 'DEDUPE_DUPLICATES_PRESENT' });
        expect(await dedupeIndexes()).toHaveLength(0);

        const db = { collection: () => { throw new Error('should not touch db'); } };
        await expect(createNotificationDedupeIndex(db)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
        expect(confirmationPresent([])).toBe(false);
        expect(confirmationPresent([CONFIRM_FLAG])).toBe(true);

        expect(productionTargetRefusals({
            env: { PM2_NAME: 'Ahram_Core_API' },
            cwd: '/tmp/not-production',
            processTitle: 'node'
        }).join(' ')).toContain('PM2_NAME');
        expect(productionTargetRefusals({
            env: { APP_DIR: 'C:/Users/Administrator/Desktop/vodafone-cash-v2' },
            cwd: '/tmp/not-production',
            processTitle: 'node'
        }).join(' ')).toContain('APP_DIR');
        expect(productionTargetRefusals({
            env: { MONGO_URI: 'mongodb://localhost:27017/vodafone_cash_system' },
            cwd: '/tmp/not-production',
            processTitle: 'node'
        }).join(' ')).toContain('vodafone_cash_system');
        expect(() => assertNotProductionTarget({
            env: { PM2_APP_NAME: 'ahram_core_api' },
            cwd: '/tmp/not-production',
            processTitle: 'node'
        })).toThrow(/PRODUCTION_TARGET_REFUSED/);
        expect(productionTargetRefusals({
            env: {},
            cwd: '/tmp/not-production',
            processTitle: 'node',
            databaseName: 'notification_dedupe_test'
        })).toEqual([]);
    });
});

describe('explicit-key notification dedupe without and with the manual index', () => {
    const burst = async (dedupeKey, width) => {
        await Promise.all(Array.from({ length: width }, () => recordInAppNotification({
            userId: 'user-dedupe',
            title: 'طلب تحويل',
            message: 'نص الإشعار',
            type: 'transfer',
            dedupeKey
        })));
        return Notification.countDocuments({ dedupeKey });
    };

    test('sequential explicit keys stay one row when the unique index is absent', async () => {
        expect(await dedupeIndexes()).toHaveLength(0);
        const dedupeKey = 'sequential-key';
        await recordInAppNotification({
            userId: 'user-seq',
            title: 'طلب تحويل',
            message: 'الأول',
            type: 'transfer',
            dedupeKey
        });
        await recordInAppNotification({
            userId: 'user-seq',
            title: 'طلب تحويل',
            message: 'الثاني',
            type: 'transfer',
            dedupeKey
        });
        expect(await Notification.countDocuments({ dedupeKey })).toBe(1);
        expect(await dedupeIndexes()).toHaveLength(0);
    });

    test('concurrent explicit keys without the unique index are measured and are not exactly-once', async () => {
        expect(await dedupeIndexes()).toHaveLength(0);
        const counts = [];
        for (let round = 0; round < 8; round += 1) {
            counts.push(await burst(`concurrent-absent-${round}`, 24));
        }
        const maxCount = Math.max(...counts);
        // Measured on MongoMemoryReplSet: overlapping upserts of one absent key
        // insert more than one row. The exact counts vary by scheduling.
        expect(maxCount).toBeGreaterThan(1);
        expect(counts).toHaveLength(8);
        expect(counts.every((count) => count >= 1)).toBe(true);
    });

    test('the manual script creates only dedupeKey_1 and concurrent explicit keys stay one row', async () => {
        const duplicates = await checkNotificationDedupeDuplicates(mongoose.connection.db);
        await Notification.deleteMany({
            dedupeKey: { $in: duplicates.duplicateGroups.map((group) => group.dedupeKey) }
        });
        const result = await createNotificationDedupeIndex(mongoose.connection.db, { confirm: true });
        expect(result.created).toBe(true);
        expect(result.name).toBe(INDEX_NAME);
        const created = await dedupeIndexes();
        expect(created).toHaveLength(1);
        expect(created[0]).toEqual(expect.objectContaining({
            name: INDEX_NAME,
            unique: true,
            sparse: true
        }));
        expect(await burst('concurrent-indexed', 24)).toBe(1);
        const again = await createNotificationDedupeIndex(mongoose.connection.db, { confirm: true });
        expect(again.alreadyPresent).toBe(true);
        expect(await dedupeIndexes()).toHaveLength(1);
    });
});
