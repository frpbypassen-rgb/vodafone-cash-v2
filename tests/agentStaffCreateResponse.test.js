jest.mock('../services/agentCredentialService', () => ({}));
jest.mock('../services/agentPortalContextService', () => ({ getAgentActor: jest.fn() }));
jest.mock('../services/auditService', () => ({ logAction: jest.fn() }));
jest.mock('../models/AgentEmployee', () => ({ create: jest.fn(), exists: jest.fn() }));
jest.mock('../models/User', () => ({ exists: jest.fn() }));
jest.mock('../models/SubAccount', () => ({ exists: jest.fn() }));
jest.mock('../models/ClientEmployee', () => ({ exists: jest.fn() }));
jest.mock('../models/Employee', () => ({ exists: jest.fn() }));
jest.mock('../models/Admin', () => ({ exists: jest.fn() }));
const { postAddStaff } = require('../controllers/agent/staffController');
const { getAgentActor } = require('../services/agentPortalContextService');
const AgentEmployee = require('../models/AgentEmployee');
let req, res;
beforeEach(() => {
    jest.clearAllMocks();
    getAgentActor.mockResolvedValue({ actor: { _id: 'owner-a', role: 'agent', name: 'Owner' }, agent: { _id: 'agency-a', tenantId: 'tenant-a' }, actorModel: 'User' });
    AgentEmployee.create.mockResolvedValue({ _id: 'new-staff' });
    AgentEmployee.exists.mockResolvedValue(null);
    req = { baseUrl: '/agent-portal', headers: { accept: 'application/json' }, body: { name: 'Test Staff', phone: '0912345678', webUsername: 'test_staff', webPassword: 'Test-Only-Password1', role: 'employee' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn(), redirect: jest.fn() };
});
test('async creation retains agency ownership and does not grant staff creation permission', async () => {
    req.body.canManageAgent = 'on';
    await postAddStaff(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(AgentEmployee.create).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'agency-a', tenantId: 'tenant-a', canManageAgent: true, canCreateAgentStaff: false }));
    expect(res.json).toHaveBeenCalledWith({ success: true, code: 'created' });
});
test('accountant creation retains reports permission without adding manager permission', async () => {
    req.body.role = 'accountant';
    await postAddStaff(req, res);
    expect(AgentEmployee.create).toHaveBeenCalledWith(expect.objectContaining({ role: 'accountant', canViewAllReports: true, canManageAgent: false }));
});
test('duplicate username returns an inline error and creates no account', async () => {
    AgentEmployee.exists.mockResolvedValue(true);
    await postAddStaff(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, code: 'username' });
    expect(AgentEmployee.create).not.toHaveBeenCalled();
});
test('employees cannot use the async endpoint to create staff', async () => {
    getAgentActor.mockResolvedValue({ actor: { role: 'employee' }, agent: { _id: 'agency-a' } });
    await postAddStaff(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(AgentEmployee.create).not.toHaveBeenCalled();
});
test('unsupported role is rejected', async () => {
    req.body.role = 'owner';
    await postAddStaff(req, res);
    expect(res.json).toHaveBeenCalledWith({ success: false, code: 'missing' });
    expect(AgentEmployee.create).not.toHaveBeenCalled();
});
test('legacy form submissions keep their redirect', async () => {
    req.headers.accept = 'text/html';
    await postAddStaff(req, res);
    expect(res.redirect).toHaveBeenCalledWith('/client/staff?staffSuccess=created');
});

test('custom creation persists only explicitly selected permissions', async () => {
    req.body.permissionsMode='custom';
    req.body.permission_canViewBalance='on';
    await postAddStaff(req,res);
    expect(AgentEmployee.create).toHaveBeenCalledWith(expect.objectContaining({canManageAgent:false,staffPermissions:expect.objectContaining({canTransfer:false,canViewBalance:true,canManageStaff:false})}));
});
test('delegated creation cannot bypass selected permissions with legacy manager input', async () => {
    getAgentActor.mockResolvedValue({actor:{_id:'delegate',role:'employee',canCreateAgentStaff:true},agent:{_id:'agency-a'}});
    req.body.canManageAgent='on';
    await postAddStaff(req,res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(AgentEmployee.create).not.toHaveBeenCalled();
});
describe('updating permissions', () => {
    const {postUpdatePermissions}=require('../controllers/agent/staffController');
    beforeEach(()=>{
        AgentEmployee.findOne=jest.fn(()=>({lean:async()=>({_id:'target',agentId:'agency-a',tenantId:'tenant-a',role:'employee',status:'active',sessionVersion:4})}));
        AgentEmployee.findOneAndUpdate=jest.fn().mockResolvedValue({_id:'target'});
        req.params={id:'target'};
        req.body={permissionsMode:'custom',permission_canViewBalance:'on',version:'4'};
    });
    test('owned updates revoke sessions and pending authentication tokens',async()=>{
        await postUpdatePermissions(req,res);
        expect(AgentEmployee.findOne).toHaveBeenCalledWith(expect.objectContaining({agentId:'agency-a',tenantId:'tenant-a'}));
        expect(AgentEmployee.findOneAndUpdate).toHaveBeenCalledWith(expect.objectContaining({agentId:'agency-a',sessionVersion:4}),expect.objectContaining({$inc:{sessionVersion:1},$unset:expect.objectContaining({refreshToken:'',otpCode:''}),$set:expect.objectContaining({staffPermissions:expect.objectContaining({canViewBalance:true,canTransfer:false})})}),expect.any(Object));
        expect(res.json).toHaveBeenCalledWith({success:true,code:'permissions_updated'});
    });
    test('cross-agency targets are denied',async()=>{
        AgentEmployee.findOne.mockReturnValue({lean:async()=>null});
        await postUpdatePermissions(req,res);
        expect(res.status).toHaveBeenCalledWith(403);
        expect(AgentEmployee.findOneAndUpdate).not.toHaveBeenCalled();
    });
    test('stale concurrent edits do not overwrite newer permissions',async()=>{
        req.body.version='3';
        await postUpdatePermissions(req,res);
        expect(res.status).toHaveBeenCalledWith(409);
        expect(AgentEmployee.findOneAndUpdate).not.toHaveBeenCalled();
    });
});
