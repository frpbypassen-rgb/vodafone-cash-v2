'use strict';
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { editTransactionAmount, repriceTransaction } = require('../services/adminFinancialMutationService');
let replica;
beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri());
    await Promise.all([User.init(), Transaction.init()]);
});
afterAll(async () => {
    await mongoose.disconnect();
    await replica?.stop();
});
beforeEach(async () => {
    await User.deleteMany({});
    await Transaction.deleteMany({});
});
test.each([
    ['pending', 'amount', 50, 'actor'],
    ['deposit', 'amount', 200, 'actor'],
    ['deposit', 'amount', 200, 'deposit'],
    ['deposit', 'amount', 200, 'adjustment'],
    ['pending', 'rate', 125, 'actor'],
])(
    'admin %s %s correction stays with the immutable owner after phone reassignment',
    async (status, change, expected, source) => {
        const owner = await User.create({
            name: 'Original owner',
            phone: '0911111111',
            webUsername: 'original',
            webPassword: 'isolated-test',
            balance: 100,
        });
        const other = await User.create({
            name: 'New phone holder',
            phone: '0922222222',
            webUsername: 'other',
            webPassword: 'isolated-test',
            balance: 100,
        });
        const identity =
            source === 'deposit'
                ? { depositRequest: { submittedByRole: 'client', submittedById: owner._id } }
                : source === 'adjustment'
                  ? { balanceAdjustment: { entityModel: 'User', entityId: owner._id, delta: 100 } }
                  : { clientActorModel: 'User', clientActorId: owner.id };
        const tx = await Transaction.create({
            ...identity,
            customId: 'AUDIT-OWNER-1',
            userId: other.phone,
            amount: 100,
            costLYD: 50,
            exchangeRate: 2,
            transferType: 'vodafone',
            status,
        });
        if (change === 'rate')
            await repriceTransaction({ transactionId: tx.id, newRate: 4, adminName: 'Audit admin' });
        else await editTransactionAmount({ transactionId: tx.id, newAmount: 200, adminName: 'Audit admin' });
        expect((await User.findById(owner._id)).balance).toBe(expected);
        expect((await User.findById(other._id)).balance).toBe(100);
    }
);
