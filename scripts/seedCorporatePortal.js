'use strict';

require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });

if (process.env.NODE_ENV === 'production' || process.env.ALLOW_CORPORATE_DEMO_SEED !== 'true') {
    console.error('Refusing to seed corporate demo data. Set NODE_ENV!=production and ALLOW_CORPORATE_DEMO_SEED=true.');
    process.exit(1);
}

const mongoose = require('mongoose');
const crypto = require('crypto');
const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const CorporateBeneficiary = require('../models/CorporateBeneficiary');
const SecurityDevice = require('../models/SecurityDevice');
const { enableCompanyPortal, assignCorporateRole } = require('../services/corporateOnboardingService');
const securityControl = require('../services/securityControlService');

const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/vodafone_cash_system';
const demoPassword = 'CorpDemo!234';

const stableDemoDeviceId = (username) => {
    const hex = crypto.createHash('sha256').update(`corporate-demo-device:${username}`).digest('hex').slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

const enrollFirstDemoDevice = async (employee) => {
    const deviceId = stableDemoDeviceId(employee.webUsername);
    await SecurityDevice.updateMany(
        { principalType: 'client_company', principalId: String(employee._id), status: 'active' },
        { $set: { status: 'revoked', revokedAt: new Date(), revokedReason: 'corporate_demo_seed_replace' } }
    );
    await SecurityDevice.create({
        principalType: 'client_company',
        principalId: String(employee._id),
        channel: 'web',
        displayName: 'جهاز تجريبي — بوابة الشركات',
        deviceIdHash: securityControl.hashDeviceId(deviceId),
        status: 'active',
        approvedBy: 'corporate_demo_seed',
        approvedAt: new Date(),
        lastSeenAt: new Date()
    });
    return deviceId;
};

const upsertEmployee = async ({ companyId, name, username, corporateRole, approvalLimit, phone }) => {
    let employee = await ClientEmployee.findOne({ webUsername: username });
    if (!employee) {
        employee = await ClientEmployee.create({
            companyId,
            name,
            phone,
            webUsername: username,
            webPassword: demoPassword,
            role: corporateRole === 'manager' ? 'owner' : corporateRole,
            status: 'active',
            canManageCompany: corporateRole === 'manager',
            canCreateCompanyStaff: corporateRole === 'manager',
            canViewAllReports: corporateRole !== 'employee',
            corporatePortalEnabled: true
        });
    }
    await assignCorporateRole({
        employeeId: employee._id,
        companyId,
        corporateRole,
        approvalLimit,
        enabled: true
    });
    return employee;
};

const run = async () => {
    await mongoose.connect(uri);
    let company = await ClientCompany.findOne({ name: 'شركة تجريبية — بوابة الشركات' });
    if (!company) {
        company = await ClientCompany.create({
            name: 'شركة تجريبية — بوابة الشركات',
            phone: '01000000001',
            status: 'active',
            balance: 50000,
            creditLimit: 0
        });
    }

    await enableCompanyPortal({
        companyId: company._id,
        brandingName: 'أهرام كورب تجريبي',
        sharedDailyLimit: 100000,
        defaultEmployeeApprovalLimit: 500,
        defaultManagerApprovalLimit: 20000
    });

    const manager = await upsertEmployee({
        companyId: company._id,
        name: 'مدير تجريبي',
        username: 'corp.manager@ahram.com',
        corporateRole: 'manager',
        approvalLimit: 20000,
        phone: '01000000011'
    });
    const employee = await upsertEmployee({
        companyId: company._id,
        name: 'موظف تجريبي',
        username: 'corp.employee@ahram.com',
        corporateRole: 'employee',
        approvalLimit: 500,
        phone: '01000000012'
    });
    const accountant = await upsertEmployee({
        companyId: company._id,
        name: 'محاسب تجريبي',
        username: 'corp.accountant@ahram.com',
        corporateRole: 'accountant',
        approvalLimit: 0,
        phone: '01000000013'
    });

    const managerDevice = await enrollFirstDemoDevice(manager);
    const employeeDevice = await enrollFirstDemoDevice(employee);
    const accountantDevice = await enrollFirstDemoDevice(accountant);

    const existingPayee = await CorporateBeneficiary.findOne({ companyId: company._id, name: 'مورد تجريبي' });
    if (!existingPayee) {
        const encrypted = CorporateBeneficiary.encryptAccountNumber('01098765432');
        await CorporateBeneficiary.create({
            companyId: company._id,
            name: 'مورد تجريبي',
            serviceType: 'vodafone',
            createdById: manager._id,
            createdByName: manager.name,
            ...encrypted
        });
    }

    console.log('Corporate demo company ready (non-production only).');
    console.log(`Company: ${company._id}`);
    console.log('Logins (password CorpDemo!234):');
    console.log('  manager    corp.manager@ahram.com');
    console.log('  employee   corp.employee@ahram.com');
    console.log('  accountant corp.accountant@ahram.com');
    console.log('First-device approval is pre-seeded. Use cookie ahrampay_security_device or header x-device-id:');
    console.log(`  manager    ${managerDevice}`);
    console.log(`  employee   ${employeeDevice}`);
    console.log(`  accountant ${accountantDevice}`);
    await mongoose.disconnect();
};

run().catch((error) => {
    console.error(error);
    process.exit(1);
});
