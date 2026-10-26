'use strict';
jest.mock('../services/companyReportEmailMailer',()=>({configured:jest.fn(()=>true),sendCode:jest.fn(async()=>{}),sendStatement:jest.fn(async()=>{})}));
jest.mock('../services/companyDailyStatementService',()=>({...jest.requireActual('../services/companyDailyStatementService'),createStatementPdf:jest.fn(async()=>Buffer.from('test-pdf'))}));
const mongoose=require('mongoose');
const {MongoMemoryServer}=require('mongodb-memory-server');
const Company=require('../models/ClientCompany');
const Staff=require('../models/ClientEmployee');
const Subscription=require('../models/CompanyReportEmail');
const Delivery=require('../models/CompanyReportEmailDelivery');
const mailer=require('../services/companyReportEmailMailer');
const statement=require('../services/companyDailyStatementService');
const worker=require('../services/companyReportEmailWorker');
const service=require('../services/companyReportEmailService');
const {resolveCompanyAccess,toPortalPermissions}=require('../services/companyAccessService');
const {buildWorkspaceResult}=require('../services/portalWorkspace/factory');
let server,workspace,subscription;
beforeAll(async()=>{process.env.SESSION_SECRET ||=require('crypto').randomBytes(32).toString('hex');server=await MongoMemoryServer.create({binary:{version:'7.0.24'}});await mongoose.connect(server.getUri());await Promise.all([Subscription.init(),Delivery.init()]);},120000);
afterAll(async()=>{worker.stop();await mongoose.disconnect();await server.stop();});
beforeEach(async()=>{
    jest.clearAllMocks();mailer.sendStatement.mockResolvedValue({});statement.createStatementPdf.mockResolvedValue(Buffer.from('test-pdf'));
    await Promise.all([Company.deleteMany({}),Staff.deleteMany({}),Subscription.deleteMany({}),Delivery.deleteMany({})]);
    const tenantId=new mongoose.Types.ObjectId();
    const company=await Company.create({name:'Test',status:'active',tenantId});
    const actor=await Staff.create({companyId:company._id,tenantId,name:'Owner',role:'owner',corporateRole:'manager',webUsername:'email_owner@ahram.com',webPassword:'$2test'});
    workspace=buildWorkspaceResult({type:'company',actor,entity:company,actorModel:'ClientEmployee',entityModel:'ClientCompany',permissions:toPortalPermissions(resolveCompanyAccess(actor))});
    subscription=await Subscription.create({...service.ownerFilter(workspace),email:'local@example.com',enabled:true,verifiedAt:new Date(Date.now()-86400000)});
});
test('daily enqueue and concurrent delivery do not send twice',async()=>{
    const job=await worker.enqueue(subscription,'2026-10-26');await worker.enqueue(subscription,'2026-10-26');
    expect(await Delivery.countDocuments({})).toBe(1);
    await Promise.all([worker.deliver(job._id),worker.deliver(job._id)]);
    expect(mailer.sendStatement).toHaveBeenCalledTimes(1);expect((await Delivery.findById(job._id)).status).toBe('sent');
});
test('revoking consent during PDF generation cancels delivery',async()=>{
    statement.createStatementPdf.mockImplementationOnce(async()=>{await Subscription.updateOne({_id:subscription._id},{$set:{enabled:false}});return Buffer.from('pdf');});
    const job=await worker.enqueue(subscription,'2026-10-26');
    expect((await worker.deliver(job._id)).status).toBe('cancelled');expect(mailer.sendStatement).not.toHaveBeenCalled();
});
test('ambiguous SMTP failure is never automatically resent',async()=>{
    mailer.sendStatement.mockRejectedValueOnce(Object.assign(new Error('ambiguous'),{code:'ETIMEDOUT'}));
    const job=await worker.enqueue(subscription,'2026-10-26');expect((await worker.deliver(job._id)).status).toBe('uncertain');
    await worker.deliver(job._id,new Date(Date.now()+3600000));expect(mailer.sendStatement).toHaveBeenCalledTimes(1);
});
test('definite SMTP connection failure remains retryable',async()=>{
    mailer.sendStatement.mockRejectedValueOnce(Object.assign(new Error('connection'),{code:'ECONNREFUSED'}));
    const job=await worker.enqueue(subscription,'2026-10-26');expect((await worker.deliver(job._id)).status).toBe('failed');
    expect((await worker.deliver(job._id,new Date(Date.now()+3600000))).status).toBe('sent');expect(mailer.sendStatement).toHaveBeenCalledTimes(2);
});
test('expired verification code cannot activate email',async()=>{
    const pending=await service.requestCode(workspace,'new@example.com');const code=mailer.sendCode.mock.calls.at(-1)[1];
    await Subscription.updateOne({_id:subscription._id},{$set:{challengeExpiresAt:new Date(0)}});
    await expect(service.verifyCode(workspace,pending.challengeId,code)).rejects.toMatchObject({code:'CODE_EXPIRED'});
    expect((await Subscription.findById(subscription._id)).email).toBe('local@example.com');
});
test('worker refuses a subscription moved to a different tenant',async()=>{
    const input=subscription.toObject();input.tenantId=new mongoose.Types.ObjectId();
    await expect(worker.loadWorkspace(input)).rejects.toMatchObject({statusCode:403});
});
