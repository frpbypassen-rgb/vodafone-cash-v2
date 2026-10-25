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
const staffController = require('../controllers/agent/staffController');
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

const staffRequest = (staffId, newPassword = 'new-password') => ({
    session: { accountType: 'user', clientId: agent._id, clientSessionVersion: 0 },
    params: { id: String(staffId) },
    body: { newPassword },
});
const staffResponse = () => {
    const res = { redirect: jest.fn(), status: jest.fn() };
    res.status.mockReturnValue(res);
    return res;
};
const seedStaff = async () => {
    await User.collection.insertOne(agent);
    return AgentEmployee.create({
        agentId: agent._id,
        name: 'Staff',
        webUsername: 'staff@ahram.com',
        webPassword: 'old-password',
        status: 'active',
        sessionVersion: 2,
        refreshToken: 'old-refresh',
        otpChallengeId: 'old-challenge',
        otpCode: 'old-code',
    });
};
test('concurrent staff password resets cannot reuse the same session version', async () => {
    const target = await seedStaff();
    const original = AgentEmployee.findOne.bind(AgentEmployee);
    let release,
        reads = 0;
    const bothRead = new Promise((resolve) => {
        release = resolve;
    });
    const spy = jest.spyOn(AgentEmployee, 'findOne').mockImplementation(async (filter) => {
        const record = await original(filter);
        reads += 1;
        if (reads === 2) release();
        await bothRead;
        return record;
    });
    const responses = [staffResponse(), staffResponse()];
    try {
        await Promise.all([
            staffController.postResetStaffPassword(staffRequest(target._id, 'first-password'), responses[0]),
            staffController.postResetStaffPassword(staffRequest(target._id, 'second-password'), responses[1]),
        ]);
    } finally {
        spy.mockRestore();
    }
    expect((await AgentEmployee.findById(target._id)).sessionVersion).toBe(4);
    for (const response of responses)
        expect(response.redirect).toHaveBeenCalledWith('/client/staff?staffSuccess=password');
});
test('staff deleted after authorization cannot be restored by a stale status save', async () => {
    const target = await seedStaff();
    const original = AgentEmployee.findOne.bind(AgentEmployee);
    const spy = jest.spyOn(AgentEmployee, 'findOne').mockImplementationOnce(async (filter) => {
        const record = await original(filter);
        await AgentEmployee.updateOne({ _id: target._id }, { $set: { status: 'deleted' } });
        return record;
    });
    try {
        await staffController.postToggleStaff(staffRequest(target._id), staffResponse());
    } finally {
        spy.mockRestore();
    }
    expect((await AgentEmployee.findById(target._id)).status).toBe('deleted');
});

test('credential rotation hashes once, clears pending authentication and rejects stale self changes', async () => {
    const bcrypt = require('bcryptjs');
    const { rotateAgentPassword } = require('../services/agentCredentialService');
    const target = await seedStaff();
    const originalHash = target.webPassword;
    const updated = await rotateAgentPassword({
        accountModel: 'AgentEmployee',
        accountId: target._id,
        agentId: agent._id,
        newPassword: ' new-password ',
    });
    expect(await bcrypt.compare(' new-password ', updated.webPassword)).toBe(true);
    expect(await bcrypt.compare('new-password', updated.webPassword)).toBe(false);
    expect(updated.sessionVersion).toBe(3);
    for (const field of ['refreshToken', 'otpCode', 'otpChallengeId']) expect(updated[field]).toBeUndefined();
    await expect(
        rotateAgentPassword({
            accountModel: 'AgentEmployee',
            accountId: target._id,
            agentId: agent._id,
            expectedPasswordHash: originalHash,
            newPassword: 'stale-password',
            requireActive: true,
        })
    ).rejects.toMatchObject({ code: 'AGENT_ACCOUNT_CHANGED' });
    expect((await AgentEmployee.findById(target._id)).webPassword).toBe(updated.webPassword);
});

test('credential writes cannot cross agencies or restore deleted accounts', async () => {
    const { rotateAgentPassword } = require('../services/agentCredentialService');
    const target = await seedStaff();
    const request = {
        accountModel: 'AgentEmployee',
        accountId: target._id,
        agentId: new mongoose.Types.ObjectId(),
        newPassword: 'new-password',
    };
    await expect(rotateAgentPassword(request)).rejects.toMatchObject({ code: 'AGENT_ACCOUNT_CHANGED' });
    await AgentEmployee.updateOne({ _id: target._id }, { $set: { status: 'deleted' } });
    await expect(rotateAgentPassword({ ...request, agentId: agent._id })).rejects.toMatchObject({
        code: 'AGENT_ACCOUNT_CHANGED',
    });
    expect((await AgentEmployee.findById(target._id)).sessionVersion).toBe(2);
});

test('repeated explicit suspension stays suspended and does not advance session versions twice', async () => {
    const target = await seedStaff();
    const request = staffRequest(target._id);
    request.body.nextStatus = 'banned';
    await staffController.postToggleStaff(request, staffResponse());
    await staffController.postToggleStaff(request, staffResponse());
    const updated = await AgentEmployee.findById(target._id);
    expect(updated.status).toBe('banned');
    expect(updated.sessionVersion).toBe(3);
    expect(updated.refreshToken).toBeUndefined();
});

test('owner password rotation uses the agent identity and invalidates the previous hash', async () => {
    const bcrypt = require('bcryptjs');
    const { rotateAgentPassword } = require('../services/agentCredentialService');
    const hash = await bcrypt.hash('old-password', 12);
    await User.collection.insertOne({
        ...agent,
        webPassword: hash,
        sessionVersion: 8,
        refreshToken: 'old-refresh',
    });
    const updated = await rotateAgentPassword({
        accountModel: 'User',
        accountId: agent._id,
        expectedPasswordHash: hash,
        newPassword: 'owner-password',
        requireActive: true,
    });
    expect(updated.sessionVersion).toBe(9);
    expect(updated.refreshToken).toBeUndefined();
    expect(await bcrypt.compare('owner-password', updated.webPassword)).toBe(true);
    await expect(
        rotateAgentPassword({
            accountModel: 'ClientEmployee',
            accountId: agent._id,
            newPassword: 'other-password',
        })
    ).rejects.toThrow('INVALID_AGENT_ACCOUNT');
    await User.updateOne({ _id: agent._id }, { $set: { role: 'user' } });
    await expect(
        rotateAgentPassword({ accountModel: 'User', accountId: agent._id, newPassword: 'other-password' })
    ).rejects.toMatchObject({ code: 'AGENT_ACCOUNT_CHANGED' });
    expect((await User.findById(agent._id)).sessionVersion).toBe(9);
});
