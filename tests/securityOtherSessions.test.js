'use strict';
const mongoose=require('mongoose');
const {MongoMemoryServer}=require('mongodb-memory-server');
const SecurityDevice=require('../models/SecurityDevice');
const AccessRequest=require('../models/SecurityAccessRequest');
const SecurityState=require('../models/SecurityState');
const security=require('../services/securityControlService');
let mongo,principal,req,web,app,foreign;
jest.setTimeout(120000);
beforeAll(async()=>{mongo=await MongoMemoryServer.create({binary:{version:'7.0.24'}});await mongoose.connect(mongo.getUri());await SecurityDevice.init();});
afterAll(async()=>{await mongoose.disconnect();await mongo.stop();});
beforeEach(async()=>{
    await Promise.all([SecurityDevice.deleteMany({}),AccessRequest.deleteMany({}),SecurityState.deleteMany({})]);security.invalidateStateCache();
    principal={principalType:'agent_staff',principalId:'staff-a'};
    const deviceId='11111111-1111-4111-8111-111111111111';
    req={headers:{},session:{securityDeviceId:deviceId},originalUrl:'/security/sessions/revoke-others'};
    [web,app,foreign]=await SecurityDevice.create([
        {...principal,channel:'web',status:'active',deviceIdHash:security.hashDeviceId(deviceId)},
        {...principal,channel:'app',status:'active',deviceIdHash:security.hashDeviceId('other-device')},
        {principalType:'agent_staff',principalId:'staff-b',channel:'web',status:'active',deviceIdHash:security.hashDeviceId('foreign-device')}
    ]);
});
test('bulk revoke retains current web session and does not affect another account',async()=>{
    expect(await security.revokeOtherPrincipalDevices({principal,req})).toEqual({revokedCount:1});
    expect((await SecurityDevice.findById(web._id)).status).toBe('active');
    expect((await SecurityDevice.findById(app._id)).status).toBe('revoked');
    expect((await SecurityDevice.findById(foreign._id)).status).toBe('active');
});
test('unrecognized current binding cannot revoke any session',async()=>{
    req.session.securityDeviceId='22222222-2222-4222-8222-222222222222';
    await expect(security.revokeOtherPrincipalDevices({principal,req})).rejects.toThrow('SECURITY_CURRENT_DEVICE_REQUIRED');
    expect(await SecurityDevice.countDocuments({status:'active'})).toBe(3);
});
test('repeating an authorized bulk revoke is harmless',async()=>{
    await security.revokeOtherPrincipalDevices({principal,req});
    expect(await security.revokeOtherPrincipalDevices({principal,req})).toEqual({revokedCount:0});
});
test('session listing identifies the current device without exposing binding hashes',async()=>{
    const data=await security.listPrincipalSessions({principal,req});
    expect(data.devices).toHaveLength(2);
    expect(data.devices.find(device=>device.id===String(web._id)).current).toBe(true);
    expect(data.devices.some(device=>Object.hasOwn(device,'deviceIdHash'))).toBe(false);
});
test('single revoke cannot target a foreign account',async()=>{
    await expect(security.revokePrincipalDevice({principal,req,deviceId:foreign._id})).rejects.toThrow('SECURITY_DEVICE_NOT_FOUND');
    expect((await SecurityDevice.findById(foreign._id)).status).toBe('active');
});
test('single revoke identifies current-device logout correctly',async()=>{
    const result=await security.revokePrincipalDevice({principal,req,deviceId:web._id});
    expect(result.current).toBe(true);expect((await SecurityDevice.findById(web._id)).status).toBe('revoked');
});
const pending=overrides=>AccessRequest.create({...principal,requestCode:'TEST-'+new mongoose.Types.ObjectId(),channel:'web',deviceIdHash:security.hashDeviceId('new-device'),expiresAt:new Date(Date.now()+60000),...overrides});
test('pending access requests can be rejected without touching active devices',async()=>{
    const request=await pending();
    await security.reviewPrincipalAccessRequest({principal,requestId:request._id,approve:false});
    expect((await AccessRequest.findById(request._id)).status).toBe('rejected');
    expect(await SecurityDevice.countDocuments({status:'active'})).toBe(3);
});
test('required administration approval is enforced by the server',async()=>{
    const request=await pending();
    await expect(security.reviewPrincipalAccessRequest({principal,requestId:request._id,approve:true})).rejects.toThrow('SECURITY_ADMIN_APPROVAL_REQUIRED');
    expect((await AccessRequest.findById(request._id)).status).toBe('pending');
});
test('permitted approval replaces only the old device in the same account and channel',async()=>{
    await SecurityState.create({key:'global',adminApprovalRequired:false});security.invalidateStateCache();
    const request=await pending();const result=await security.reviewPrincipalAccessRequest({principal,requestId:request._id,approve:true});
    expect(result.device.status).toBe('active');
    expect((await SecurityDevice.findById(web._id)).status).toBe('revoked');
    expect((await SecurityDevice.findById(app._id)).status).toBe('active');
    expect((await SecurityDevice.findById(foreign._id)).status).toBe('active');
});
test('expired requests cannot be reviewed as active requests',async()=>{
    const request=await pending({expiresAt:new Date(Date.now()-1000)});
    await expect(security.reviewPrincipalAccessRequest({principal,requestId:request._id,approve:false})).rejects.toThrow('SECURITY_ACCESS_REQUEST_EXPIRED');
});
