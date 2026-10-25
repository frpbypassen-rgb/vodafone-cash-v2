'use strict';
jest.mock('../services/auditService', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }));
const mongoose = require('mongoose');
const { MongoMemoryReplSet } = require('mongodb-memory-server');
const RegistrationRequest = require('../models/RegistrationRequest');
const SubAccount = require('../models/SubAccount');
const AccountCode = require('../models/AccountCode');
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const AgentEmployee = require('../models/AgentEmployee');
const Employee = require('../models/Employee');
const Admin = require('../models/Admin');
const Transaction = require('../models/Transaction');
const { buildAgentTransactionScope } = require('../services/agentTransactionScopeService');
const { approveAgentRegistration, rejectAgentRegistration } = require('../services/agentRegistrationService');
let replica, agent, registration, context;
jest.setTimeout(120000);
beforeAll(async () => {
    replica = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    await mongoose.connect(replica.getUri());
    await Promise.all(
        [
            RegistrationRequest,
            SubAccount,
            AccountCode,
            User,
            ClientCompany,
            ClientEmployee,
            AgentEmployee,
            Employee,
            Admin,
        ].map((Model) => Model.init())
    );
});
afterAll(async () => {
    await mongoose.disconnect();
    if (replica) await replica.stop();
});
beforeEach(async () => {
    await Promise.all(
        [RegistrationRequest, SubAccount, AccountCode, Transaction, User, AgentEmployee].map((Model) =>
            Model.deleteMany({})
        )
    );
    agent = { _id: new mongoose.Types.ObjectId(), status: 'active', role: 'agent', name: 'Agency' };
    registration = await RegistrationRequest.create({
        accountType: 'new',
        status: 'pending_agent',
        agentId: agent._id,
        fullName: 'Customer',
        phone: '0911234567',
        username: 'customer@ahram.com',
        password: 'password12',
    });
    context = { actor: agent, agent, actorModel: 'User', id: registration._id, req: { body: {} } };
});
test('parallel approvals create exactly one customer and one matching account code', async () => {
    const results = await Promise.allSettled([
        approveAgentRegistration(context),
        approveAgentRegistration(context),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await SubAccount.countDocuments({ masterId: agent._id })).toBe(1);
    const customer = await SubAccount.findOne({ masterId: agent._id });
    expect(customer.accountCode).toMatch(/^\d{6}$/);
    expect(await AccountCode.countDocuments({ ownerId: customer._id, code: customer.accountCode })).toBe(1);
    expect((await RegistrationRequest.findById(registration._id)).status).toBe('approved');
});
test('approval and rejection cannot both commit for the same request', async () => {
    const results = await Promise.allSettled([
        approveAgentRegistration(context),
        rejectAgentRegistration(context),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const final = await RegistrationRequest.findById(registration._id);
    expect(await SubAccount.countDocuments({ masterId: agent._id })).toBe(
        final.status === 'approved' ? 1 : 0
    );
});
test('an account-code failure rolls back the customer and approval', async () => {
    const fail = jest
        .spyOn(SubAccount, 'findByIdAndUpdate')
        .mockRejectedValueOnce(new Error('ACCOUNT_CODE_WRITE_FAILED'));
    await expect(approveAgentRegistration(context)).rejects.toThrow('ACCOUNT_CODE_WRITE_FAILED');
    fail.mockRestore();
    expect(await SubAccount.countDocuments({ masterId: agent._id })).toBe(0);
    expect(await AccountCode.countDocuments({})).toBe(0);
    expect((await RegistrationRequest.findById(registration._id)).status).toBe('pending_agent');
});
test('a foreign agency cannot approve or reject another agency request', async () => {
    const foreign = { ...agent, _id: new mongoose.Types.ObjectId() };
    const other = { ...context, actor: foreign, agent: foreign };
    await expect(approveAgentRegistration(other)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(rejectAgentRegistration(other)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await SubAccount.countDocuments({})).toBe(0);
});
test('rejection appends user notes literally, without interpreting MongoDB expressions', async () => {
    context.req.body.notes = '$status';
    const result = await rejectAgentRegistration(context);
    expect(result.status).toBe('rejected');
    expect(result.adminNotes).toBe('$status');
});
test('employee and delegated-report scopes keep transactions inside the owning agency', async () => {
    agent.phone = 'agency-phone';
    agent.webUsername = 'agency@ahram.com';
    const ownId = new mongoose.Types.ObjectId();
    const peerId = new mongoose.Types.ObjectId();
    const foreignId = new mongoose.Types.ObjectId();
    await Transaction.collection.insertMany([
        {
            _id: ownId,
            customId: 'AGENT-OWN',
            userId: agent.phone,
            clientActorId: 'staff-a',
            employeeName: 'Same name',
        },
        {
            _id: peerId,
            customId: 'AGENT-PEER',
            userId: agent.phone,
            clientActorId: 'staff-b',
            employeeName: 'Same name',
        },
        {
            _id: foreignId,
            customId: 'AGENT-FOREIGN',
            userId: 'foreign-agency',
            clientActorId: 'staff-a',
            employeeName: 'Same name',
        },
    ]);
    const actor = { _id: 'staff-a', name: 'Same name', role: 'employee' };
    const limited = await Transaction.find(await buildAgentTransactionScope({ agent, actor })).distinct(
        '_id'
    );
    expect(limited.map(String)).toEqual([String(ownId)]);
    actor.canViewAllReports = true;
    const delegated = await Transaction.find(await buildAgentTransactionScope({ agent, actor })).distinct(
        '_id'
    );
    expect(delegated.map(String).sort()).toEqual([String(ownId), String(peerId)].sort());
});
test('multi-tenant reports cannot match a foreign tenant with the same phone identity', async () => {
    const previousMode = process.env.TENANT_MODE;
    process.env.TENANT_MODE = 'multi';
    try {
        agent.phone = 'shared-phone';
        agent.tenantId = new mongoose.Types.ObjectId();
        const ownId = new mongoose.Types.ObjectId();
        await Transaction.collection.insertMany([
            { _id: ownId, customId: 'TENANT-OWN', userId: agent.phone, tenantId: agent.tenantId },
            { customId: 'TENANT-FOREIGN', userId: agent.phone, tenantId: new mongoose.Types.ObjectId() },
        ]);
        const results = await Transaction.find(await buildAgentTransactionScope({ agent })).distinct('_id');
        expect(results.map(String)).toEqual([String(ownId)]);
    } finally {
        if (previousMode === undefined) delete process.env.TENANT_MODE;
        else process.env.TENANT_MODE = previousMode;
    }
});

test('the inactive staff filter includes suspended accounts and excludes deleted and foreign staff', async () => {
    await User.collection.insertOne(agent);
    const suspendedId = new mongoose.Types.ObjectId();
    await AgentEmployee.collection.insertMany([
        {
            _id: suspendedId,
            agentId: agent._id,
            status: 'banned',
            role: 'employee',
            name: 'Suspended',
            webUsername: 'suspended@ahram.com',
        },
        {
            agentId: agent._id,
            status: 'active',
            role: 'employee',
            name: 'Active',
            webUsername: 'active@ahram.com',
        },
        {
            agentId: agent._id,
            status: 'deleted',
            role: 'employee',
            name: 'Deleted',
            webUsername: 'deleted@ahram.com',
        },
        {
            agentId: new mongoose.Types.ObjectId(),
            status: 'banned',
            role: 'employee',
            name: 'Foreign',
            webUsername: 'foreign@ahram.com',
        },
    ]);
    const { loadPageContext } = require('../services/businessPortalService');
    const context = await loadPageContext(
        { session: { clientId: agent._id, accountType: 'user' }, query: { status: 'inactive' } },
        'staff'
    );
    expect(context.staff.map((person) => String(person._id))).toEqual([String(suspendedId)]);
});
