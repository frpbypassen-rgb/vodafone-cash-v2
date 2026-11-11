'use strict';

let mockCreditTail = Promise.resolve();
jest.mock('../services/clientNotificationService', () => ({
    createClientNotifications: jest.fn(async () => {}),
    notifyBalanceAdjustment: jest.fn(async () => {})
}));
jest.mock('../services/walletService', () => {
    const actual = jest.requireActual('../services/walletService');
    return {
        ...actual,
        updateBalanceWithLedger: jest.fn(async (...args) => {
            const previous = mockCreditTail;
            let release;
            mockCreditTail = new Promise(resolve => { release = resolve; });
            await previous;
            try { return await actual.updateBalanceWithLedger(...args); }
            finally { release(); }
        })
    };
});

const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const SupportTicket = require('../models/SupportTicket');
const Ledger = require('../models/Ledger');
const { resolveClientDepositTicket, listClientDepositRequests, createClientDepositRequest } = require('../services/clientDepositRequestService');
const admin = { id: 'test-admin', name: 'Test reviewer' };
let replica;
jest.setTimeout(60000);

beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(replica.getUri());
    await Promise.all([User.init(), Transaction.init(), SupportTicket.init(), Ledger.init()]);
});
afterAll(async () => {
    await mongoose.disconnect();
    await replica?.stop();
});
beforeEach(async () => {
    jest.restoreAllMocks();
    mockCreditTail = Promise.resolve();
    await Promise.all([User.deleteMany({}), Transaction.deleteMany({}), SupportTicket.deleteMany({}), Ledger.deleteMany({})]);
});

const fixture = async () => {
    const other = await User.create({
        name: 'Other client', webUsername: '0911111111', webPassword: 'test-password',
        tenantId: new mongoose.Types.ObjectId()
    });
    const owner = await User.create({
        name: 'Deposit owner', webUsername: 'deposit-owner', webPassword: 'test-password',
        phone: '0911111111', tenantId: new mongoose.Types.ObjectId()
    });
    const tx = await Transaction.create({
        customId: 'AUDIT-DEPOSIT-1', userId: owner.phone, amount: 100, status: 'deposit_pending',
        tenantId: owner.tenantId,
        depositRequest: { submittedById: owner._id, submittedByRole: 'client' }
    });
    const ticket = await SupportTicket.create({
        entityType: 'client_user', entityId: owner._id, name: owner.name,
        metadata: { type: 'client_deposit', clientUserId: String(owner._id),
            depositRequest: { transactionId: String(tx._id), status: 'pending' } }
    });
    tx.depositRequest.supportTicketId = ticket._id;
    await tx.save();
    return { owner, other, tx, ticket };
};

test('colliding phone and username never reveal or credit another client deposit', async () => {
    const { owner, other, ticket } = await fixture();
    expect(await listClientDepositRequests({ client: other })).toEqual([]);
    await resolveClientDepositTicket({ ticketId: ticket.id, admin, approved: true });
    expect((await User.findById(owner._id)).balance).toBe(100);
    expect((await User.findById(other._id)).balance).toBe(0);
    expect((await Ledger.findOne()).tenantId).toEqual(owner.tenantId);
});

test('simultaneous reviewers apply one deposit credit and one terminal decision', async () => {
    const { owner, ticket, tx } = await fixture();
    const results = await Promise.allSettled([1, 2].map(() =>
        resolveClientDepositTicket({ ticketId: ticket.id, admin, approved: true })
    ));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await User.findById(owner._id)).balance).toBe(100);
    expect(await Ledger.countDocuments({ transactionId: tx.customId })).toBe(1);
    expect((await Transaction.findById(tx._id)).status).toBe('deposit');
    expect((await SupportTicket.findById(ticket._id)).metadata.depositRequest.status).toBe('approved');
});

test('a ticket persistence failure rolls back balance, ledger and review state together', async () => {
    const { owner, ticket, tx } = await fixture();
    jest.spyOn(SupportTicket.prototype, 'save').mockRejectedValueOnce(new Error('AUDIT_TICKET_WRITE_FAILED'));
    await expect(resolveClientDepositTicket({ ticketId: ticket.id, admin, approved: true }))
        .rejects.toThrow('AUDIT_TICKET_WRITE_FAILED');
    expect((await User.findById(owner._id)).balance).toBe(0);
    expect(await Ledger.countDocuments()).toBe(0);
    expect((await Transaction.findById(tx._id)).status).toBe('deposit_pending');
});

test('simultaneous acceptance and rejection leave credit consistent with the winning decision', async () => {
    const { owner, ticket, tx } = await fixture();
    const results = await Promise.allSettled([true, false].map(approved =>
        resolveClientDepositTicket({ ticketId: ticket.id, admin, approved, reason: 'test rejection reason' })
    ));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const approved = (await Transaction.findById(tx._id)).status === 'deposit';
    expect((await User.findById(owner._id)).balance).toBe(approved ? 100 : 0);
    expect(await Ledger.countDocuments()).toBe(approved ? 1 : 0);
});
test('legacy deposits use their owned ticket and simultaneous submissions create one complete request', async () => {
    const { owner, other, tx } = await fixture();
    await Transaction.updateOne({ _id: tx._id }, { $unset: { 'depositRequest.submittedById': 1 } });
    expect(await listClientDepositRequests({ client: other })).toEqual([]);
    expect(await listClientDepositRequests({ client: owner })).toHaveLength(1);
    await Promise.all([Transaction.deleteMany({}), SupportTicket.deleteMany({})]);
    const results = await Promise.allSettled([1, 2].map(() =>
        createClientDepositRequest({ client: owner, amount: 50, note: 'isolated audit deposit' })
    ));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(await Transaction.countDocuments({ status: 'deposit_pending' })).toBe(1);
    expect(await SupportTicket.countDocuments()).toBe(1);
    expect((await Transaction.findOne()).tenantId).toEqual(owner.tenantId);
});
test('wallet tenant context cannot credit an account belonging to another tenant', async () => {
    const { owner, other } = await fixture();
    const { updateBalanceWithLedger } = require('../services/walletService');
    await expect(updateBalanceWithLedger('User', owner._id, 100, 'DEPOSIT', 'AUDIT-WRONG-TENANT', 'test', {
        tenantId: other.tenantId
    })).rejects.toThrow('ACCOUNT_NOT_FOUND');
    expect((await User.findById(owner._id)).balance).toBe(0);
    expect(await Ledger.countDocuments()).toBe(0);
    const previousDefault = process.env.DEFAULT_TENANT_ID;
    try {
        process.env.DEFAULT_TENANT_ID = String(owner.tenantId);
        await User.updateOne({ _id: owner._id }, { $unset: { tenantId: 1 } });
        await expect(updateBalanceWithLedger('User', owner._id, 100, 'DEPOSIT', 'AUDIT-LEGACY-TENANT', 'test', {
            tenantId: other.tenantId
        })).rejects.toThrow('ACCOUNT_NOT_FOUND');
        expect((await User.findById(owner._id)).balance).toBe(0);
    } finally {
        if (previousDefault === undefined) delete process.env.DEFAULT_TENANT_ID;
        else process.env.DEFAULT_TENANT_ID = previousDefault;
    }
});
