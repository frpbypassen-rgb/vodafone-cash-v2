'use strict';
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const { loadExecutorEmployee, clearExecutorAuthCache } = require('../services/executorAuthCache');
let mongo;
jest.setTimeout(60000);
beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri(), { dbName: 'executor_auth_projection_test', autoIndex: false });
});
afterAll(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); });
test('fresh lean authentication preserves the services, pool and tenant required by dashboard reads, without credentials', async () => {
    const groupId = new mongoose.Types.ObjectId();
    const employeeId = new mongoose.Types.ObjectId();
    const poolId = new mongoose.Types.ObjectId();
    const tenantId = new mongoose.Types.ObjectId();
    await ExecutorGroup.collection.insertOne({ _id: groupId, name: 'Bank executor', status: 'active', serviceKey: 'bank_account', serviceKeys: ['bank_account','postal'], serviceBalances: { bank_account: 500, postal: 100 }, apiToken: 'must-not-leak' });
    await Employee.collection.insertOne({ _id: employeeId, name: 'External', status: 'active', role: 'external', groupId, balancePoolId: poolId, tenantId, webPassword: 'must-not-leak' });
    clearExecutorAuthCache();
    const employee = await loadExecutorEmployee(employeeId, { fresh: true, lean: true });
    expect(String(employee.balancePoolId)).toBe(String(poolId));
    expect(String(employee.tenantId)).toBe(String(tenantId));
    expect(employee.groupId).toMatchObject({ serviceKey: 'bank_account', serviceKeys: ['bank_account','postal'], serviceBalances: { bank_account: 500, postal: 100 } });
    expect(employee.webPassword).toBeUndefined();
    expect(employee.groupId.apiToken).toBeUndefined();
});
