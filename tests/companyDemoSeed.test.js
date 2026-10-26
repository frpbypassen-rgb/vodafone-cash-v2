'use strict';
const mongoose=require('mongoose');
const {main}=require('../scripts/seedLocalCompanyMobileDemo');
const {MongoMemoryServer}=require('mongodb-memory-server');
const Company=require('../models/ClientCompany');
const Ledger=require('../models/Ledger');
const Transaction=require('../models/Transaction');
const saved=Object.fromEntries(['NODE_ENV','APP_ENV','ENVIRONMENT','MONGO_URI','SEED_COMPANY_DEMO_PASSWORD'].map(key=>[key,process.env[key]]));
afterEach(()=>{jest.restoreAllMocks();for(const [key,value] of Object.entries(saved)){if(value===undefined) delete process.env[key];else process.env[key]=value;}});
const setup=()=>Object.assign(process.env,{NODE_ENV:'test',APP_ENV:'test',ENVIRONMENT:'test',SEED_COMPANY_DEMO_PASSWORD:'Test-only-demo-password!'});
test('a demo-looking query parameter cannot authorize seeding an unrelated database',async()=>{
    setup();process.env.MONGO_URI='mongodb://127.0.0.1:27017/other_application?appName=demo';
    const connect=jest.spyOn(mongoose,'connect').mockRejectedValue(new Error('UNEXPECTED_DATABASE_CONNECTION'));
    await expect(main()).rejects.toThrow('separate local demo database');
    expect(connect).not.toHaveBeenCalled();
});
test.each(['mongodb://127.0.0.1:27017/vodafone_cash_system','mongodb://remote.invalid/company_demo'])('refuses an unsafe seed target %s before connecting',async uri=>{
    setup();process.env.MONGO_URI=uri;
    const connect=jest.spyOn(mongoose,'connect').mockRejectedValue(new Error('UNEXPECTED_DATABASE_CONNECTION'));
    await expect(main()).rejects.toThrow();expect(connect).not.toHaveBeenCalled();
});
test('repeated seed preserves the financial ledger and its balance chain',async()=>{
    setup();const server=await MongoMemoryServer.create({binary:{version:'7.0.24'}});
    const log=jest.spyOn(console,'log').mockImplementation(()=>{});
    try{
        process.env.MONGO_URI=server.getUri('company_seed_demo');
        await main();await main();
        await mongoose.connect(process.env.MONGO_URI,{autoIndex:false});
        const company=await Company.findOne({accountCode:'CO-MOBILE-DEMO'}).lean();
        const rows=await Ledger.find({entityId:company._id}).sort({createdAt:1}).lean();
        expect(await Transaction.countDocuments({companyId:company._id})).toBe(25);
        expect(rows).toHaveLength(21);let balance=0;
        for(const row of rows){expect(row.balanceBefore).toBeCloseTo(balance,3);balance=row.balanceAfter;}
        expect(company.balance).toBeCloseTo(balance,3);
    }finally{log.mockRestore();await mongoose.disconnect();await server.stop();}
},120000);
