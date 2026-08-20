'use strict';

require('dotenv').config();
const mongoose = require('mongoose');

const Tenant = require('../models/Tenant');
const User = require('../models/User');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const AgentEmployee = require('../models/AgentEmployee');
const SubAccount = require('../models/SubAccount');
const RegistrationRequest = require('../models/RegistrationRequest');
const MobileDeviceSession = require('../models/MobileDeviceSession');
const Transaction = require('../models/Transaction');
const Ledger = require('../models/Ledger');
const JournalEvent = require('../models/JournalEvent');
const Reconciliation = require('../models/Reconciliation');
const Settlement = require('../models/Settlement');
const ApiProviderReturn = require('../models/ApiProviderReturn');
const ApiBalanceAudit = require('../models/ApiBalanceAudit');

const shouldApply = process.argv.includes('--apply');
const shouldCreateDefault = process.argv.includes('--create-default');
const clean = (value) => String(value || '').trim();
const tenantlessFilter = {
    $or: [
        { tenantId: { $exists: false } },
        { tenantId: null }
    ]
};

const models = [
    User,
    Employee,
    ExecutorGroup,
    ClientCompany,
    ClientEmployee,
    AgentEmployee,
    SubAccount,
    RegistrationRequest,
    MobileDeviceSession,
    Transaction,
    Ledger,
    JournalEvent,
    Reconciliation,
    Settlement,
    ApiProviderReturn,
    ApiBalanceAudit
];

const resolveDefaultTenant = async () => {
    const tenantId = clean(process.env.DEFAULT_TENANT_ID);
    const slug = clean(process.env.DEFAULT_TENANT_SLUG).toLowerCase();
    let tenant = tenantId ? await Tenant.findById(tenantId) : null;
    if (!tenant && slug) tenant = await Tenant.findOne({ slug });
    if (tenant || !shouldApply || !shouldCreateDefault) return tenant;

    if (!slug) {
        throw new Error('DEFAULT_TENANT_SLUG is required to create the default tenant.');
    }
    return Tenant.create({
        name: clean(process.env.DEFAULT_TENANT_NAME) || 'Al-Ahram Pay',
        slug,
        status: 'active'
    });
};

const main = async () => {
    const mongoUri = clean(process.env.MONGO_URI);
    if (!mongoUri || mongoUri.toLowerCase() === 'demo') {
        throw new Error('MONGO_URI must point to the target MongoDB database.');
    }
    if (!clean(process.env.DEFAULT_TENANT_ID) && !clean(process.env.DEFAULT_TENANT_SLUG)) {
        throw new Error('Set DEFAULT_TENANT_ID or DEFAULT_TENANT_SLUG before running the migration.');
    }

    await mongoose.connect(mongoUri);
    const tenant = await resolveDefaultTenant();
    if (!tenant) {
        throw new Error(
            'Default tenant was not found. Run with --apply --create-default only after verifying the target database.'
        );
    }

    console.log(`Tenant isolation migration: ${shouldApply ? 'APPLY' : 'PREVIEW'}`);
    console.log(`Target tenant: ${tenant.slug} (${tenant._id})`);

    let total = 0;
    for (const Model of models) {
        const count = await Model.countDocuments(tenantlessFilter);
        total += count;
        if (shouldApply && count > 0) {
            const result = await Model.updateMany(tenantlessFilter, {
                $set: { tenantId: tenant._id }
            });
            console.log(`${Model.modelName}: matched=${count}, modified=${result.modifiedCount}`);
        } else {
            console.log(`${Model.modelName}: tenantless=${count}`);
        }
    }

    console.log(`Total tenantless records: ${total}`);
    if (!shouldApply) {
        console.log('No data was changed. Re-run with --apply after reviewing the counts.');
    } else {
        const remaining = await Promise.all(models.map((Model) => Model.countDocuments(tenantlessFilter)));
        const remainingTotal = remaining.reduce((sum, count) => sum + count, 0);
        if (remainingTotal !== 0) {
            throw new Error(`Migration verification failed: ${remainingTotal} tenantless records remain.`);
        }
        console.log('Migration verification passed.');
    }
};

main()
    .catch((error) => {
        console.error(`Tenant migration failed: ${error.message}`);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect().catch(() => {});
    });
