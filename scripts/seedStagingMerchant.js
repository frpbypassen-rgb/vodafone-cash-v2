'use strict';

// Creates a merchant credential only in the isolated API Sandbox database.
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env.staging' });

const crypto = require('crypto');
const mongoose = require('mongoose');
const Tenant = require('../models/Tenant');
const ClientCompany = require('../models/ClientCompany');
const Settings = require('../models/Settings');

const optionValue = (flag, fallback = '') => {
    const index = process.argv.indexOf(flag);
    return index >= 0 ? String(process.argv[index + 1] || '').trim() : fallback;
};

const positiveNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const requireStaging = () => {
    if (String(process.env.NODE_ENV || '').trim().toLowerCase() !== 'staging') {
        throw new Error('This script may run only with NODE_ENV=staging.');
    }
    const uri = String(process.env.MONGO_URI || '').trim();
    if (!uri || /ahram_pay_sandbox/i.test(uri) === false) {
        throw new Error('MONGO_URI must reference the dedicated ahram_pay_sandbox database.');
    }
    return uri;
};

async function main() {
    const mongoUri = requireStaging();
    const tenantSlug = String(process.env.DEFAULT_TENANT_SLUG || 'ahram-sandbox').trim().toLowerCase();
    const companyName = optionValue('--name', process.env.STAGING_MERCHANT_NAME || 'شركة اختبار التكامل');
    const balance = positiveNumber(optionValue('--balance', process.env.STAGING_MERCHANT_BALANCE || '50000'), 50000);
    const rotateKey = process.argv.includes('--rotate-key');

    await mongoose.connect(mongoUri, { retryWrites: false });

    const tenant = await Tenant.findOneAndUpdate(
        { slug: tenantSlug },
        {
            $set: {
                name: 'Al-Ahram Pay Sandbox',
                status: 'active',
                'features.enableExternalAPI': true,
                'features.enableTelegramBots': false,
                'features.enableMobileAPI': false
            }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await Settings.findOneAndUpdate(
        {},
        { $setOnInsert: { isManualClosed: false, autoRouteEnabled: false } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    let company = await ClientCompany.findOne({ tenantId: tenant._id, name: companyName });
    let apiKey = company ? company.token : crypto.randomBytes(32).toString('hex');
    if (!company) {
        company = new ClientCompany({
            tenantId: tenant._id,
            name: companyName,
            phone: '0000000000',
            balance,
            tier: 3,
            status: 'active',
            token: apiKey,
            businessProfile: { contactName: 'Sandbox Integration Contact' }
        });
    } else {
        company.status = 'active';
        company.balance = balance;
        if (rotateKey) {
            apiKey = crypto.randomBytes(32).toString('hex');
            company.token = apiKey;
        }
    }
    await company.save();

    const baseUrl = String(process.env.PUBLIC_APP_URL || 'https://sandbox-api.ahrampay.com').replace(/\/$/, '');
    console.log('\nSandbox merchant is ready. Store this key in the partner secret manager only.');
    console.log(`Base URL: ${baseUrl}/api/v1/merchant`);
    console.log(`Merchant: ${company.name}`);
    console.log(`Balance: ${company.balance}`);
    console.log(`API key: ${apiKey}`);
}

main()
    .catch((error) => {
        console.error(`Sandbox setup failed: ${error.message}`);
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect().catch(() => {});
    });
