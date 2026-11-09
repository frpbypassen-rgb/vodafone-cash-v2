'use strict';

const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const Tenant = require('../models/Tenant');
const { findByCredentials } = require('../repositories/userRepository');
const { backfillExecutorEmployeeTenant } = require('../scripts/backfillExecutorEmployeeTenant.cjs');

jest.setTimeout(60_000);

let mongo;
const originalLegacyMode = process.env.ALLOW_LEGACY_TENANTLESS_RECORDS;

beforeAll(async () => {
    process.env.ALLOW_LEGACY_TENANTLESS_RECORDS = 'false';
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
    if (originalLegacyMode === undefined) delete process.env.ALLOW_LEGACY_TENANTLESS_RECORDS;
    else process.env.ALLOW_LEGACY_TENANTLESS_RECORDS = originalLegacyMode;
    await mongoose.disconnect();
    if (mongo) await mongo.stop();
});

test('repairs website-only executor login without loosening the mobile tenant boundary', async () => {
    const [tenantId, otherTenantId, ownGroup, otherGroup, unassignedGroup] = Array.from(
        { length: 5 }, () => new mongoose.Types.ObjectId()
    );
    await Tenant.collection.insertMany([
        { _id: tenantId, slug: 'executor-test', name: 'Executor test', status: 'active' },
        { _id: otherTenantId, slug: 'other-test', name: 'Other test', status: 'active' }
    ]);
    await ExecutorGroup.collection.insertMany([
        { _id: ownGroup, tenantId, status: 'active' },
        { _id: otherGroup, tenantId: otherTenantId, status: 'active' },
        { _id: unassignedGroup, status: 'active' }
    ]);
    const password = 'local-test-only-password';
    const webPassword = await bcrypt.hash(password, 4);
    const legacy = { webUsername: 'old_operator@ahram.com', groupId: ownGroup, status: 'active', webPassword };
    const result = await Employee.collection.insertMany([
        legacy,
        { ...legacy, _id: new mongoose.Types.ObjectId(), webUsername: 'foreign@ahram.com', groupId: otherGroup },
        { ...legacy, _id: new mongoose.Types.ObjectId(), webUsername: 'unknown@ahram.com', groupId: unassignedGroup },
        { ...legacy, _id: new mongoose.Types.ObjectId(), webUsername: 'assigned@ahram.com', tenantId: otherTenantId },
        { ...legacy, _id: new mongoose.Types.ObjectId(), webUsername: 'archived@ahram.com', archivedAt: new Date() }
    ]);

    await expect(findByCredentials('old_operator', password)).resolves.toMatchObject({ accountType: 'executor' });
    await expect(findByCredentials('old_operator', password, tenantId)).resolves.toBeNull();
    await expect(backfillExecutorEmployeeTenant({ tenantId })).resolves.toMatchObject({
        mode: 'dry-run', candidates: 1, modified: 0
    });
    await expect(findByCredentials('old_operator', password, tenantId)).resolves.toBeNull();

    await expect(backfillExecutorEmployeeTenant({ tenantId, username: 'foreign', apply: true })).resolves.toMatchObject({
        account: 'group-not-in-configured-tenant', modified: 0
    });
    await expect(backfillExecutorEmployeeTenant({ tenantId, username: 'OLD_OPERATOR' })).resolves.toMatchObject({
        account: 'eligible', candidates: 1, modified: 0
    });
    await expect(backfillExecutorEmployeeTenant({ tenantId, username: 'old_operator@ahram.com', apply: true })).resolves.toMatchObject({
        mode: 'apply', account: 'eligible', candidates: 1, modified: 1
    });
    await expect(findByCredentials('old_operator', password, tenantId)).resolves.toMatchObject({
        accountType: 'executor', executorGroupId: ownGroup
    });
    await expect(findByCredentials('old_operator', 'wrong', tenantId)).resolves.toBeNull();
    await expect(findByCredentials('old_operator', password, otherTenantId)).resolves.toBeNull();
    await expect(findByCredentials('foreign', password, tenantId)).resolves.toBeNull();
    expect(await Employee.findById(result.insertedIds[0]).lean()).toMatchObject({ webPassword, status: 'active' });
    expect((await Employee.findById(result.insertedIds[3]).lean()).tenantId).toEqual(otherTenantId);
    expect((await Employee.findById(result.insertedIds[4]).lean()).tenantId).toBeUndefined();
    await expect(backfillExecutorEmployeeTenant({ tenantId, apply: true })).resolves.toMatchObject({
        candidates: 0, modified: 0
    });
});
