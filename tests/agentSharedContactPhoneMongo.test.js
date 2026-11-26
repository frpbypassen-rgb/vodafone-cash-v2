'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../models/User');
const { findByCredentials } = require('../repositories/userRepository');

jest.setTimeout(45000);
let database;

beforeAll(async () => {
    database = await MongoMemoryServer.create();
    await mongoose.connect(database.getUri());
    await User.createIndexes();
});

afterAll(async () => {
    await mongoose.disconnect();
    await database?.stop();
});

test('two agents can share a contact phone while login phones and usernames stay independent', async () => {
    const first = await User.create({
        name: 'First test agent', role: 'agent', phone: '0910000001',
        contactPhone: '0940000000', webUsername: 'agent.alpha', webPassword: 'Alpha-test-password'
    });
    const second = await User.create({
        name: 'Second test agent', role: 'agent', phone: '0910000002',
        contactPhone: '0940000000', webUsername: 'agent.beta', webPassword: 'Beta-test-password'
    });

    expect(await User.countDocuments({ contactPhone: '0940000000' })).toBe(2);
    expect(String((await findByCredentials('agent.alpha', 'Alpha-test-password')).account._id)).toBe(String(first._id));
    expect(String((await findByCredentials('agent.beta', 'Beta-test-password')).account._id)).toBe(String(second._id));
    expect(await findByCredentials('0940000000', 'Alpha-test-password')).toBeNull();
    await expect(User.create({
        name: 'Duplicate login phone', role: 'agent', phone: '0910000001',
        webUsername: 'agent.gamma', webPassword: 'Gamma-test-password'
    })).rejects.toMatchObject({ code: 11000 });
});
