'use strict';
jest.mock('../services/agentPortalContextService', () => ({ getAgentActor: jest.fn() }));
jest.mock('../services/auditService', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }));
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../models/User');
const Staff = require('../models/AgentEmployee');
const { getAgentActor } = require('../services/agentPortalContextService');
const { loadAgentPortalActor } = require('../services/agentPortalAccessService');
const { postUpdatePermissions } = require('../controllers/agent/staffController');
const { resolveAgentPermissions } = require('../utils/agentPortalPolicy');
let mongo, owner, target, req;
const oldMode=process.env.TENANT_MODE;
jest.setTimeout(120000);
beforeAll(async()=>{process.env.TENANT_MODE='multi';mongo=await MongoMemoryServer.create({binary:{version:'7.0.24'}});await mongoose.connect(mongo.getUri());});
afterAll(async()=>{await mongoose.disconnect();await mongo.stop();if(oldMode===undefined)delete process.env.TENANT_MODE;else process.env.TENANT_MODE=oldMode;});
beforeEach(async()=>{
    await Promise.all([User.collection.deleteMany({}),Staff.collection.deleteMany({})]);
    owner={_id:new mongoose.Types.ObjectId(),tenantId:new mongoose.Types.ObjectId(),name:'Owner',role:'agent',status:'active'};
    target={_id:new mongoose.Types.ObjectId(),agentId:owner._id,tenantId:owner.tenantId,name:'Staff',role:'employee',status:'active',sessionVersion:0,refreshToken:'test-refresh',otpCode:'123456'};
    await User.collection.insertOne(owner);await Staff.collection.insertOne(target);
    getAgentActor.mockResolvedValue({actor:owner,agent:owner,actorModel:'User'});
    req={params:{id:String(target._id)},body:{permissionsMode:'custom',permission_canViewBalance:'on',version:'0'}};
});
const response=()=>({status:jest.fn().mockReturnThis(),json:jest.fn()});
test('persisted permission update invalidates old sessions and clears authentication tokens',async()=>{
    const res=response();await postUpdatePermissions(req,res);
    expect(res.json).toHaveBeenCalledWith({success:true,code:'permissions_updated'});
    const stored=await Staff.findById(target._id).lean();
    expect(stored.sessionVersion).toBe(1);expect(stored.refreshToken).toBeUndefined();expect(stored.otpCode).toBeUndefined();
    expect(resolveAgentPermissions(stored)).toMatchObject({canViewBalance:true,canTransfer:false,canManageCustomers:false});
    const oldSession={session:{accountType:'agent_staff',clientId:String(target._id),clientSessionVersion:0},tenant:{_id:owner.tenantId}};
    await expect(loadAgentPortalActor(oldSession,{lean:true})).rejects.toThrow('INVALID_AGENT_SESSION');
    oldSession.session.clientSessionVersion=1;
    await expect(loadAgentPortalActor(oldSession,{lean:true})).resolves.toMatchObject({actor:{sessionVersion:1}});
});
test('concurrent editors cannot both overwrite the same permission version',async()=>{
    const a=response(),b=response();await Promise.all([postUpdatePermissions(req,a),postUpdatePermissions(req,b)]);
    const results=[a.json.mock.calls[0][0],b.json.mock.calls[0][0]];
    expect(results.filter(r=>r.success)).toHaveLength(1);expect(results.filter(r=>r.code==='changed')).toHaveLength(1);
    expect((await Staff.findById(target._id).lean()).sessionVersion).toBe(1);
});
test('foreign agency members are not modified',async()=>{
    await Staff.collection.updateOne({_id:target._id},{$set:{agentId:new mongoose.Types.ObjectId()}});
    const res=response();await postUpdatePermissions(req,res);expect(res.status).toHaveBeenCalledWith(403);
    expect((await Staff.findById(target._id).lean()).staffPermissions).toBeUndefined();
});
test('legacy members without a session version can be updated safely',async()=>{
    await Staff.collection.updateOne({_id:target._id},{$unset:{sessionVersion:''}});
    const res=response();await postUpdatePermissions(req,res);
    expect(res.json).toHaveBeenCalledWith({success:true,code:'permissions_updated'});
    expect((await Staff.findById(target._id).lean()).sessionVersion).toBe(1);
});
