'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const ClientCompany = require('../models/ClientCompany');
const Tenant = require('../models/Tenant');

let sandboxConnectionPromise = null;

const clean = (value) => String(value || '').trim();
const normalizeOrigin = (value) => clean(value).replace(/\/+$/, '');

const sandboxConfiguration = () => {
    const mongoUri = clean(process.env.SANDBOX_MONGO_URI);
    const apiOrigin = normalizeOrigin(process.env.SANDBOX_API_URL);
    const productionUri = clean(process.env.MONGO_URI);

    if (!mongoUri || !apiOrigin) {
        const error = new Error('SANDBOX_NOT_CONFIGURED');
        error.code = 'SANDBOX_NOT_CONFIGURED';
        throw error;
    }
    if (!/^https?:\/\//i.test(apiOrigin)) {
        const error = new Error('SANDBOX_API_URL_INVALID');
        error.code = 'SANDBOX_API_URL_INVALID';
        throw error;
    }
    if (mongoUri === productionUri || !/\/ahram_pay_sandbox(?:\?|$)/i.test(mongoUri)) {
        const error = new Error('SANDBOX_DATABASE_UNSAFE');
        error.code = 'SANDBOX_DATABASE_UNSAFE';
        throw error;
    }

    const balance = Number(process.env.SANDBOX_DEFAULT_MERCHANT_BALANCE);
    return {
        mongoUri,
        apiOrigin,
        tenantSlug: clean(process.env.SANDBOX_TENANT_SLUG || 'ahram-sandbox').toLowerCase(),
        defaultBalance: Number.isFinite(balance) && balance >= 0 ? balance : 50000
    };
};

const getSandboxModels = async (mongoUri) => {
    if (!sandboxConnectionPromise) {
        sandboxConnectionPromise = mongoose.createConnection(mongoUri, {
            serverSelectionTimeoutMS: 7000,
            maxPoolSize: 5
        }).asPromise().then((connection) => ({
            connection,
            ClientCompany: connection.model('ClientCompany', ClientCompany.schema),
            Tenant: connection.model('Tenant', Tenant.schema)
        })).catch((error) => {
            sandboxConnectionPromise = null;
            throw error;
        });
    }
    return sandboxConnectionPromise;
};

const sourceReference = (account, accountType) => `${accountType}:${String(account._id)}`;

const createSandboxKey = () => crypto.randomBytes(32).toString('hex');

const provisionSandboxMerchant = async ({ account, accountType }) => {
    if (!account || !account._id || !['company', 'agent'].includes(accountType)) {
        throw new Error('SANDBOX_ACCOUNT_INVALID');
    }

    const config = sandboxConfiguration();
    const { ClientCompany: SandboxCompany, Tenant: SandboxTenant } = await getSandboxModels(config.mongoUri);
    const sourceId = String(account._id);
    const sourceKey = sourceReference(account, accountType);

    const tenant = await SandboxTenant.findOneAndUpdate(
        { slug: config.tenantSlug },
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

    let merchant = await SandboxCompany.findOne({
        'sandboxSource.reference': sourceKey,
        tenantId: tenant._id
    });

    if (!merchant) {
        merchant = new SandboxCompany({
            tenantId: tenant._id,
            name: `Sandbox - ${clean(account.name) || accountType}`,
            phone: clean(account.phone) || '0000000000',
            accountCode: `SBX${sourceId.toUpperCase()}`,
            balance: config.defaultBalance,
            tier: Number(account.tier) || 3,
            status: 'active',
            token: createSandboxKey(),
            sandboxSource: {
                reference: sourceKey,
                productionAccountId: sourceId,
                productionAccountType: accountType
            },
            businessProfile: {
                contactName: clean(account.businessProfile?.contactName) || clean(account.name),
                email: clean(account.businessProfile?.email),
                city: clean(account.businessProfile?.city),
                address: clean(account.businessProfile?.address),
                registrationNumber: `SANDBOX-${sourceId.slice(-8).toUpperCase()}`
            }
        });
        try {
            await merchant.save();
        } catch (error) {
            if (error?.code !== 11000) throw error;
            merchant = await SandboxCompany.findOne({
                'sandboxSource.reference': sourceKey,
                tenantId: tenant._id
            });
            if (!merchant) throw error;
        }
    }

    return {
        apiKey: merchant.token,
        apiOrigin: config.apiOrigin,
        account: merchant.toObject()
    };
};

module.exports = {
    provisionSandboxMerchant,
    sandboxConfiguration
};
