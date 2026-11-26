'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../models/User');
const { findByCredentials } = require('../repositories/userRepository');
const { verifiedSmsPhone, phoneProof, normalizeSmsLoginPhone } = require('../utils/smsLoginPhone');

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

test('a changed agent phone is primary for login while a shared phone requires the username', async () => {
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
    expect(await findByCredentials('0940000000', 'Alpha-test-password')).toMatchObject({ error: 'PHONE_SHARED_USE_USERNAME' });
    expect(await findByCredentials('0910000001', 'Alpha-test-password')).toBeNull();
    first.contactPhone = '0930000001';
    await first.save();
    expect(String((await findByCredentials('0930000001', 'Alpha-test-password')).account._id)).toBe(String(first._id));
    await User.create({
        name: 'Direct customer', role: 'user', phone: '0930000001',
        webUsername: 'customer.unique', webPassword: 'Customer-test-password'
    });
    expect(await findByCredentials('0930000001', 'Alpha-test-password'))
        .toMatchObject({ error: 'PHONE_SHARED_USE_USERNAME' });
    expect(String((await findByCredentials('agent.alpha', 'Alpha-test-password')).account._id)).toBe(String(first._id));
    await expect(User.create({
        name: 'Duplicate login phone', role: 'agent', phone: '0910000001',
        webUsername: 'agent.gamma', webPassword: 'Gamma-test-password'
    })).rejects.toMatchObject({ code: 11000 });
});

test('existing agent SMS proof for the legacy phone routes OTP to the changed primary number', () => {
    const agent = {
        role: 'agent', phone: '0910000001', contactPhone: '0940000000',
        smsOtpVerifiedPhoneHash: phoneProof(normalizeSmsLoginPhone('0910000001'))
    };
    expect(verifiedSmsPhone(agent)).toBe('218940000000');
    expect(verifiedSmsPhone({ ...agent, smsOtpVerifiedPhoneHash: '' })).toBe('');
});
