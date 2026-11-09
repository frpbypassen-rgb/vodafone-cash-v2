'use strict';

const mongoose = require('mongoose');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const Tenant = require('../models/Tenant');

// Only the group's persisted tenant is authoritative for a legacy employee.
const backfillExecutorEmployeeTenant = async ({ tenantId, apply = false }) => {
    if (!mongoose.isValidObjectId(tenantId)) throw new Error('A valid tenant id is required.');
    const tenant = await Tenant.exists({ _id: tenantId, status: 'active' });
    if (!tenant) throw new Error('The selected tenant is not active.');

    const missingTenant = { tenantId: null, archivedAt: null };
    const groups = ExecutorGroup.find({ tenantId, status: 'active', archivedAt: null })
        .select('_id').lean().cursor();
    const summary = { mode: apply ? 'apply' : 'dry-run', candidates: 0, modified: 0 };
    for await (const group of groups) {
        const filter = { ...missingTenant, groupId: group._id };
        summary.candidates += await Employee.countDocuments(filter);
        if (apply) {
            const result = await Employee.updateMany(filter, { $set: { tenantId } }, { timestamps: false });
            summary.modified += result.modifiedCount;
        }
    }
    summary.remainingUnassigned = await Employee.countDocuments(missingTenant);
    return summary;
};

const main = async () => {
    require('dotenv').config({ quiet: true });
    const args = process.argv.slice(2);
    if (args.some(arg => arg !== '--apply')) throw new Error('Usage: node scripts/backfillExecutorEmployeeTenant.cjs [--apply]');
    const mongoUri = String(process.env.MONGO_URI || '').trim();
    const defaultId = String(process.env.DEFAULT_TENANT_ID || '').trim();
    const defaultSlug = String(process.env.DEFAULT_TENANT_SLUG || '').trim().toLowerCase();
    if (!mongoUri || (!defaultId && !defaultSlug)) {
        throw new Error('MONGO_URI and DEFAULT_TENANT_ID or DEFAULT_TENANT_SLUG are required.');
    }
    await mongoose.connect(mongoUri, { autoIndex: false, autoCreate: false });
    try {
        const tenant = await Tenant.findOne(defaultId ? { _id: defaultId } : { slug: defaultSlug }).select('_id').lean();
        if (!tenant) throw new Error('The configured default tenant was not found.');
        const result = await backfillExecutorEmployeeTenant({ tenantId: tenant._id, apply: args.includes('--apply') });
        console.log(JSON.stringify(result, null, 2));
    } finally {
        await mongoose.disconnect();
    }
};

if (require.main === module) {
    main().catch(() => {
        console.error('Executor employee tenant backfill failed. Verify database access and the configured default tenant.');
        process.exitCode = 1;
    });
}

module.exports = { backfillExecutorEmployeeTenant };
