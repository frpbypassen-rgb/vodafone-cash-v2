'use strict';
const ClientEmployee = require('../../models/ClientEmployee');
const AgentEmployee = require('../../models/AgentEmployee');
const User = require('../../models/User');
const SubAccount = require('../../models/SubAccount');
const Employee = require('../../models/Employee');
const Admin = require('../../models/Admin');
const mongoose = require('mongoose');
const {
    isMongoTransactionFallbackError,
    requiresMongoTransactions,
    financialTransactionsUnavailableError,
} = require('../../services/walletService');
const Counter = require('../../models/Counter');

const USERNAME_DOMAIN = '@ahram.com';

const checked = (value) => ['1', 'true', 'on', 'yes'].includes(String(value || '').toLowerCase());

const cleanText = (value, maxLength = 160) =>
    String(value || '')
        .trim()
        .slice(0, maxLength);

const normalizeUsername = (rawUsername) => {
    const base = cleanText(rawUsername, 64).toLowerCase();
    const username = base.includes('@') ? base : `${base}${USERNAME_DOMAIN}`;
    if (!/^[a-z0-9_]{3,40}@ahram\.com$/.test(username)) throw new Error('INVALID_USERNAME');
    return username;
};

const assertIdentityAvailable = async ({ webUsername, phone }) => {
    const usernameQueries = [
        ClientEmployee.exists({ webUsername }),
        AgentEmployee.exists({ webUsername }),
        User.exists({ webUsername }),
        SubAccount.exists({ webUsername }),
        Employee.exists({ webUsername }),
        Admin.exists({ webUsername }),
    ];
    const phoneQueries = phone
        ? [
              ClientEmployee.exists({ phone }),
              AgentEmployee.exists({ phone }),
              User.exists({ phone }),
              SubAccount.exists({ phone }),
              Employee.exists({ phone }),
          ]
        : [];
    const matches = await Promise.all([...usernameQueries, ...phoneQueries]);
    if (matches.some(Boolean)) throw new Error('IDENTITY_TAKEN');
};

const redirectWithMessage = (res, path, type, code) => {
    const origin = 'https://portal.invalid';
    let target;
    try {
        target = new URL(typeof path === 'string' ? path : '', origin);
        if (
            typeof path !== 'string' ||
            !path.startsWith('/') ||
            path.startsWith('//') ||
            target.origin !== origin ||
            !/^\/(client|agent-portal)(\/|$)/.test(target.pathname)
        )
            throw new Error('INVALID_RETURN_PATH');
    } catch (_) {
        target = new URL('/client/settings', origin);
    }
    target.searchParams.set(type, code);
    return res.redirect(`${target.pathname}${target.search}${target.hash}`);
};

const passwordPageHref = (workspace) => (workspace?.isCompany ? '/client/security' : '/client/settings');

const customerOwnerFilter = (workspace, id = null) => ({
    ...(id ? { _id: id } : {}),
    masterType: workspace.masterType,
    masterId: workspace.masterId,
    status: { $ne: 'deleted' },
});

const requireCustomerManager = (workspace) => {
    if (!workspace.permissions.canManageCustomers) {
        const error = new Error('FORBIDDEN');
        error.statusCode = 403;
        throw error;
    }
};

const runDbTransaction = async (callback) => {
    let session;
    try {
        session = await mongoose.startSession();
        session.startTransaction();
        const result = await callback(session);
        await session.commitTransaction();
        return result;
    } catch (error) {
        if (session) {
            try {
                await session.abortTransaction();
            } catch (_) {}
        }
        if (isMongoTransactionFallbackError(error)) {
            if (requiresMongoTransactions()) {
                throw financialTransactionsUnavailableError(error);
            }
            return callback(null);
        }
        if (!session && requiresMongoTransactions()) {
            throw financialTransactionsUnavailableError(error);
        }
        throw error;
    } finally {
        if (session) session.endSession();
    }
};

const nextSettlementId = async (session) => {
    const counter = await Counter.findOneAndUpdate(
        { name: 'portal_customer_settlement' },
        { $inc: { value: 1 } },
        { upsert: true, new: true, ...(session ? { session } : {}) }
    );
    const now = new Date();
    return `SET-${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}-${String(counter.value).padStart(5, '0')}`;
};
module.exports = {
    USERNAME_DOMAIN,
    checked,
    cleanText,
    normalizeUsername,
    assertIdentityAvailable,
    redirectWithMessage,
    passwordPageHref,
    customerOwnerFilter,
    requireCustomerManager,
    runDbTransaction,
    nextSettlementId,
};
