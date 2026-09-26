'use strict';

/**
 * Opt-in duplicate scan, then optional compound unique index on AccountCode.
 *
 * Default is a scan only. No index is created unless ALL of the following are true:
 *   --apply
 *   ALLOW_ACCOUNT_CODE_TENANT_INDEX=true
 *   the duplicate scan returns zero groups
 *
 * The existing global unique index on AccountCode.code is left in place.
 * This script must never run automatically at process boot.
 *
 *   node scripts/prepareAccountCodeTenantIndex.js
 *   $env:ALLOW_ACCOUNT_CODE_TENANT_INDEX='true'
 *   node scripts/prepareAccountCodeTenantIndex.js --apply
 */

const INDEX_NAME = 'account_code_tenant_code_unique';

const duplicatePipeline = (tenantField = '$tenantId') => ([
    {
        $group: {
            _id: { tenantId: tenantField, code: '$code' },
            count: { $sum: 1 }
        }
    },
    { $match: { count: { $gt: 1 } } }
]);

const scanAccountCodeDuplicates = async (AccountCode) => {
    const byTenant = await AccountCode.aggregate(duplicatePipeline('$tenantId'));
    const globalCodes = await AccountCode.aggregate([
        { $group: { _id: '$code', count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } }
    ]);
    return {
        tenantCodeDuplicates: byTenant.length,
        globalCodeDuplicates: globalCodes.length,
        sample: byTenant.slice(0, 20).map((row) => ({
            tenantId: row._id && row._id.tenantId ? String(row._id.tenantId) : null,
            code: row._id && row._id.code,
            count: row.count
        }))
    };
};

const scanOwnerCodeDuplicates = async ({ User, ClientCompany, SubAccount }) => {
    const scan = async (Model) => Model.aggregate([
        { $match: { accountCode: { $nin: [null, ''] } } },
        { $group: { _id: { tenantId: '$tenantId', code: '$accountCode' }, count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } }
    ]);
    const [users, companies, subAccounts] = await Promise.all([
        scan(User),
        scan(ClientCompany),
        scan(SubAccount)
    ]);
    return {
        User: users.length,
        ClientCompany: companies.length,
        SubAccount: subAccounts.length
    };
};

const createTenantCodeIndex = async (AccountCode) => AccountCode.collection.createIndex(
    { tenantId: 1, code: 1 },
    {
        name: INDEX_NAME,
        unique: true,
        partialFilterExpression: {
            tenantId: { $type: 'objectId' },
            code: { $type: 'string' }
        }
    }
);

const runPrepare = async ({ apply = false, allowIndex = false, AccountCode, User, ClientCompany, SubAccount }) => {
    const reservation = await scanAccountCodeDuplicates(AccountCode);
    const owners = await scanOwnerCodeDuplicates({ User, ClientCompany, SubAccount });
    const duplicates = reservation.tenantCodeDuplicates
        + reservation.globalCodeDuplicates
        + owners.User
        + owners.ClientCompany
        + owners.SubAccount;
    const report = {
        mode: 'scan',
        indexCreated: false,
        indexName: INDEX_NAME,
        duplicates,
        reservation,
        owners,
        note: 'Global unique index on AccountCode.code is unchanged. A compound unique index is created only with --apply and ALLOW_ACCOUNT_CODE_TENANT_INDEX=true after a clean scan.'
    };
    if (!apply) return report;
    if (!allowIndex) {
        report.blocked = 'ALLOW_ACCOUNT_CODE_TENANT_INDEX is not true';
        return report;
    }
    if (duplicates > 0) {
        report.blocked = 'duplicate scan is not clean';
        return report;
    }
    await createTenantCodeIndex(AccountCode);
    report.mode = 'apply';
    report.indexCreated = true;
    return report;
};

const main = async () => {
    require('dotenv').config();
    const mongoose = require('mongoose');
    const mongoUri = String(process.env.MONGO_URI || '').trim();
    if (!mongoUri || mongoUri.toLowerCase() === 'demo') {
        throw new Error('MONGO_URI must point at the database to scan.');
    }
    await mongoose.connect(mongoUri);
    const report = await runPrepare({
        apply: process.argv.includes('--apply'),
        allowIndex: ['1', 'true', 'yes', 'on'].includes(String(process.env.ALLOW_ACCOUNT_CODE_TENANT_INDEX || '').trim().toLowerCase()),
        AccountCode: require('../models/AccountCode'),
        User: require('../models/User'),
        ClientCompany: require('../models/ClientCompany'),
        SubAccount: require('../models/SubAccount')
    });
    console.log(JSON.stringify(report, null, 2));
    await mongoose.disconnect();
    if (report.blocked) process.exitCode = 2;
};

if (require.main === module) {
    main().catch((error) => {
        console.error(`Account code index preparation failed: ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    INDEX_NAME,
    scanAccountCodeDuplicates,
    scanOwnerCodeDuplicates,
    runPrepare
};
