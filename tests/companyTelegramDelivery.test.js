'use strict';
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const Company = require('../models/ClientCompany');
const CompanyConnection = require('../models/CompanyTelegramConnection');
const AgentConnection = require('../models/AgentTelegramConnection');
const telegram = require('../services/telegramService');
let db, company, tenantId, actorId;
beforeAll(async () => {
    process.env.TENANT_MODE = 'multi';
    db = await MongoMemoryServer.create({ binary: { version: '7.0.24' } });
    await mongoose.connect(db.getUri());
}, 120000);
afterAll(async () => { await mongoose.disconnect(); await db.stop(); });
beforeEach(async () => {
    await Promise.all([Company.deleteMany({}),CompanyConnection.deleteMany({}),AgentConnection.deleteMany({})]);
    tenantId = new mongoose.Types.ObjectId(); actorId = new mongoose.Types.ObjectId();
    company = await Company.create({ name: 'Demo', status: 'active', tenantId });
});
const tx = () => ({ _id: new mongoose.Types.ObjectId(), companyId: company._id, tenantId, status: 'completed', customId: 'DEMO-RECEIPT', amount: 100 });
const connection = (chatId, extra={}) => CompanyConnection.create({ companyId: company._id, tenantId, requestedById: actorId, requestedByModel: 'ClientEmployee', name: 'Demo', chatId, linkedAt: new Date(), enabled: true, ...extra });

test('receipt routing includes enabled company connections and excludes paused, removed and foreign accounts', async () => {
    await connection('11111');
    await connection('22222', { enabled: false });
    await connection('33333', { deletedAt: new Date() });
    await connection('44444', { companyId: new mongoose.Types.ObjectId() });
    await connection('55555', { tenantId: new mongoose.Types.ObjectId() });
    const links = await telegram.findLinksForTransaction(tx());
    expect(links.map(link=>link.chatId)).toEqual(['11111']);
    expect(links[0].connectionModel).toBe('company');
});

test('agent connections cannot receive company receipts even when entity IDs match', async () => {
    await AgentConnection.create({ agentId: company._id, tenantId, requestedById: actorId, requestedByModel: 'User', name: 'Agent only', chatId: '99999', enabled: true, linkedAt: new Date() });
    expect(await telegram.findLinksForTransaction(tx())).toEqual([]);
});

test('paused company blocks receipt lookup', async () => {
    await connection('11111');
    await Company.updateOne({ _id:company._id }, { $set: { status:'banned' } });
    expect(await telegram.findLinksForTransaction(tx())).toEqual([]);
});
