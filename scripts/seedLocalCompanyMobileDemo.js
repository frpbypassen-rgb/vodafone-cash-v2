'use strict';
const mongoose = require('mongoose');
const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const Transaction = require('../models/Transaction');
const Ledger = require('../models/Ledger');
const Settings = require('../models/Settings');
const { assertLocalSeedTarget, requireSecret } = require('./lib/productionDatabaseGuard');

async function main() {
    const { databaseName } = assertLocalSeedTarget(process.env);
    if (!/(?:^|[_-])(demo|test)(?:$|[_-])/i.test(databaseName)) throw new Error('Use a separate local demo database.');
    const password = requireSecret(process.env, 'SEED_COMPANY_DEMO_PASSWORD', 12);
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
    try {
        const company = await ClientCompany.findOneAndUpdate({ accountCode: 'CO-MOBILE-DEMO' }, { $setOnInsert: {
            name: 'شركة الأفق التجريبية', phone: '0910000100', status: 'active', tier: 1,
            balance: 0, creditLimit: 0, businessProfile: { contactName: 'أحمد — مدير الشركة', city: 'طرابلس', address: 'بيانات تجريبية للمعاينة', registrationNumber: 'DEMO-2026' }
        } }, { upsert: true, returnDocument: 'after' });
        await Settings.findOneAndUpdate({}, { $setOnInsert: { isManualClosed: false, openingTime: '00:00', closingTime: '23:59' } }, { upsert: true });
        const staff = [];
        const definitions = [
            ['company_demo','أحمد — مدير الشركة','owner',false],
            ['company_manager','محمد — مدير التشغيل','employee',true],
            ['company_accountant','سارة — المحاسبة','accountant',false],
            ['company_staff1','خالد — موظف التحويلات','employee',false],
            ['company_staff2','مريم — موظفة التحويلات','employee',false],
            ['company_paused','علي — حساب موقوف','employee',false]
        ];
        for (const [index, [username,name,role,manager]] of definitions.entries()) {
            let actor = await ClientEmployee.findOne({ webUsername: `${username}@ahram.com` });
            if (actor && String(actor.companyId) !== String(company._id)) throw new Error('Demo username belongs to another company.');
            if (!actor) actor = new ClientEmployee({ companyId: company._id, webUsername: `${username}@ahram.com` });
            Object.assign(actor, { name, phone: `091000010${index}`, role, corporateRole: manager || role === 'owner' ? 'manager' : role,
                status: username === 'company_paused' ? 'banned' : 'active', webPassword: password,
                canManageCompany: manager, canCreateTransfer: role !== 'accountant', canViewAllReports: role !== 'employee' || manager,
                canManageCompanyProfile: manager || role === 'owner', mustChangePassword: false });
            await actor.save();
            staff.push(actor);
        }
        // Never rewrite financial records on a repeated seed.
        if (!await Transaction.exists({ companyId: company._id, customId: 'DEMO-CO-OPENING' })) {
            let balance = 30000;
            const start = new Date(); start.setDate(start.getDate() - 6); start.setHours(9,0,0,0);
            const opening = await Transaction.create({ customId: 'DEMO-CO-OPENING', companyId: company._id, companyName: company.name, employeeName: staff[0].name,
                clientActorId: String(staff[0]._id), userId: staff[0].phone, amount: balance, costLYD: balance, status: 'deposit', transferType: 'deposit', createdAt: start, notes: 'تمويل افتتاحي تجريبي' });
            await Ledger.create({ entityId: company._id, entityModel: 'ClientCompany', transactionId: opening.customId, type: 'DEPOSIT', amount: balance, balanceBefore: 0, balanceAfter: balance, description: 'تمويل افتتاحي تجريبي', createdAt: start });
            for (let i = 0; i < 24; i++) {
                const actor = staff[[0,1,3,4][i % 4]];
                const amount = 100 + i * 75;
                const cost = Math.round(amount / 6.4 * 1000) / 1000;
                const date = new Date(); date.setDate(date.getDate() - (5 - Math.floor(i / 4))); date.setHours(10 + i % 4, i % 60, 0, 0);
                const status = i % 7 === 0 ? 'rejected' : 'completed';
                const tx = await Transaction.create({ customId: `DEMO-CO-${String(i+1).padStart(4,'0')}`, companyId: company._id, companyName: company.name,
                    employeeName: actor.name, clientActorId: String(actor._id), userId: actor.phone,
                    transferType: ['vodafone','bank_account','post_account','post_card'][i%4], vodafoneNumber: '01000000000',
                    accountNumber: '1234567890', accountName: 'مستفيد تجريبي', amount, costLYD: cost, exchangeRate: 6.4, status,
                    notes: 'عملية تجريبية؛ لا تمثل تحويلًا حقيقيًا', createdAt: date });
                if (status === 'completed') {
                    const before = balance; balance = Math.round((balance - cost) * 1000) / 1000;
                    await Ledger.create({ entityId: company._id, entityModel: 'ClientCompany', transactionId: tx.customId, type: 'TRANSFER', amount: -cost,
                        originalAmount: amount, originalCurrency: 'EGP', balanceBefore: before, balanceAfter: balance, description: `تحويل تجريبي — ${actor.name}`, createdAt: date });
                }
            }
            await ClientCompany.updateOne({ _id: company._id }, { $set: { balance } });
        }
        console.log(JSON.stringify({ company: company.name, username: staff[0].webUsername, staff: staff.length, transactions: await Transaction.countDocuments({ companyId: company._id }) }));
    } finally { await mongoose.disconnect(); }
}
if(require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode=1; });
module.exports = { main };
