'use strict';

const mongoose = require('mongoose');
const { parseArgs } = require('node:util');
const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const Tenant = require('../models/Tenant');

// Only the group's persisted tenant is authoritative for a legacy employee.
const backfillExecutorEmployeeTenant = async ({ tenantId, apply = false, username }) => {
    if (!mongoose.isValidObjectId(tenantId)) throw new Error('A valid tenant id is required.');
    const tenant = await Tenant.exists({ _id: tenantId, status: 'active' });
    if (!tenant) throw new Error('The selected tenant is not active.');

    const missingTenant = { tenantId: null, archivedAt: null };
    const summary = { mode: apply ? 'apply' : 'dry-run', candidates: 0, modified: 0 };
    const groupScope = { tenantId, status: 'active', archivedAt: null };
    if (username !== undefined) {
        const input = String(username).trim();
        if (!input || input.length > 80) throw new Error('Invalid executor username.');
        const escaped = input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = input.includes('@') ? escaped : escaped + '(?:@ahram\\.com)?';
        const matches = await Employee.find({ webUsername: new RegExp('^' + pattern + '$', 'i'), archivedAt: null })
            .select('_id groupId tenantId status').limit(2).lean();
        if (matches.length !== 1) {
            return { ...summary, account: matches.length ? 'ambiguous' : 'not-found' };
        }
        const employee = matches[0];
        const group = await ExecutorGroup.findById(employee.groupId).select('tenantId status archivedAt').lean();
        const groupMatches = group && !group.archivedAt && group.status === 'active'
            && String(group.tenantId || '') === String(tenantId);
        const account = employee.tenantId
            ? (String(employee.tenantId) === String(tenantId) ? 'already-assigned' : 'different-tenant')
            : (groupMatches ? 'eligible' : 'group-not-in-configured-tenant');
        const report = { ...summary, account, status: employee.status, candidates: account === 'eligible' ? 1 : 0 };
        if (apply && report.candidates) {
            const result = await Employee.updateOne(
                { ...missingTenant, _id: employee._id, groupId: employee.groupId },
                { $set: { tenantId } },
                { timestamps: false }
            );
            report.modified = result.modifiedCount;
        }
        return report;
    }

    const groups = ExecutorGroup.find(groupScope).select('_id').lean().cursor();
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
    const { values } = parseArgs({
        options: { apply: { type: 'boolean' }, username: { type: 'string' } }
    });
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
        const result = await backfillExecutorEmployeeTenant({ tenantId: tenant._id, ...values });
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
