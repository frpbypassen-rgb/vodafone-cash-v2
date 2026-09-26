'use strict';

const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const SubAccount = require('../models/SubAccount');
const AccountCode = require('../models/AccountCode');
const {
    tenantGuardEnabled,
    trustedRequestTenantId,
    codedError,
    canonicalTenantId,
    defaultTenantId
} = require('./financialSafety');

const CODE_LENGTHS = {
    user: 6,
    agent: 4,
    company: 5,
    subAccount: 6
};

const normalizeAccountCode = (code) => String(code || '').trim();

const expectedUserCodeLength = (user, hasSubAccounts = false) => {
    return user?.role === 'agent' || hasSubAccounts ? CODE_LENGTHS.agent : CODE_LENGTHS.user;
};

const validateAccountCode = (code, length) => {
    const normalized = normalizeAccountCode(code);
    if (!new RegExp(`^\\d{${length}}$`).test(normalized)) {
        throw new Error(`ACCOUNT_CODE_INVALID_${length}`);
    }
    return normalized;
};

const generateNumericCode = (length) => {
    const min = length === 1 ? 0 : 10 ** (length - 1);
    const max = (10 ** length) - 1;
    return String(Math.floor(min + Math.random() * (max - min + 1))).padStart(length, '0');
};

const findDuplicateAccountCode = async (code, current = {}) => {
    const normalized = normalizeAccountCode(code);
    if (!normalized) return null;

    const [user, company, subAccount, reservation] = await Promise.all([
        User.findOne({ accountCode: normalized }).select('_id name accountCode').lean(),
        ClientCompany.findOne({ accountCode: normalized }).select('_id name accountCode').lean(),
        SubAccount.findOne({ accountCode: normalized }).select('_id name accountCode').lean(),
        AccountCode.findOne({ code: normalized }).select('_id code ownerModel ownerId').lean()
    ]);

    const duplicate = [
        user && { modelName: 'User', doc: user },
        company && { modelName: 'ClientCompany', doc: company },
        subAccount && { modelName: 'SubAccount', doc: subAccount },
        reservation && {
            modelName: reservation.ownerModel,
            doc: { _id: reservation.ownerId, accountCode: reservation.code }
        }
    ].filter(Boolean).find((item) => {
        return !(current.modelName === item.modelName && String(current.id) === String(item.doc._id));
    });

    return duplicate || null;
};

const ensureAccountCodeAvailable = async (code, current) => {
    const duplicate = await findDuplicateAccountCode(code, current);
    if (duplicate) {
        const error = new Error('ACCOUNT_CODE_DUPLICATE');
        error.duplicate = duplicate;
        throw error;
    }
};

const duplicateReservationError = () => {
    const error = new Error('ACCOUNT_CODE_DUPLICATE');
    return error;
};

const reserveAccountCode = async (code, current, options = {}) => {
    const normalized = normalizeAccountCode(code);
    const tenantId = options.tenantId || null;
    try {
        return await AccountCode.findOneAndUpdate(
            { ownerModel: current.modelName, ownerId: current.id },
            {
                $set: {
                    code: normalized,
                    ownerModel: current.modelName,
                    ownerId: current.id,
                    ...(tenantId ? { tenantId } : {})
                }
            },
            { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
        );
    } catch (error) {
        if (error.code === 11000) throw duplicateReservationError();
        throw error;
    }
};

const assignGeneratedAccountCode = async ({ Model, modelName, id, length, maxAttempts = 200 }) => {
    const current = { modelName, id };

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const code = validateAccountCode(generateNumericCode(length), length);
        try {
            await ensureAccountCodeAvailable(code, current);
            await reserveAccountCode(code, current);
            await Model.findByIdAndUpdate(id, { accountCode: code }, { runValidators: true });
            return code;
        } catch (error) {
            if (error.message !== 'ACCOUNT_CODE_DUPLICATE') {
                await releaseAccountCodeReservation(current).catch(() => {});
                throw error;
            }
        }
    }

    throw new Error('ACCOUNT_CODE_GENERATION_FAILED');
};

const releaseAccountCodeReservation = async (current) => {
    await AccountCode.deleteOne({ ownerModel: current.modelName, ownerId: current.id });
};

const accountLabel = (modelName, doc) => {
    if (modelName === 'User') return doc.role === 'agent' ? 'وكيل' : 'عميل';
    if (modelName === 'ClientCompany') return 'شركة';
    return 'عميل وكيل';
};

const resolveFromReservation = async (reservation, normalized) => {
    const models = { User, ClientCompany, SubAccount };
    const Model = models[reservation.ownerModel];
    if (!Model) return null;

    const doc = await Model.findById(reservation.ownerId);
    if (!doc || doc.accountCode !== normalized) {
        await AccountCode.deleteOne({ _id: reservation._id }).catch(() => {});
        return null;
    }

    return { modelName: reservation.ownerModel, doc, label: accountLabel(reservation.ownerModel, doc) };
};

const tenantMatch = (tenantId) => {
    const canonical = canonicalTenantId(tenantId);
    if (canonical && canonical === defaultTenantId()) {
        return {
            $or: [
                { tenantId: canonical },
                { tenantId: null },
                { tenantId: { $exists: false } }
            ]
        };
    }
    return { tenantId: canonical };
};

const findForeignAccount = async (normalized, tenantId) => {
    const expected = canonicalTenantId(tenantId);
    const [user, company, subAccount] = await Promise.all([
        User.findOne({ accountCode: normalized }).select('_id tenantId').lean(),
        ClientCompany.findOne({ accountCode: normalized }).select('_id tenantId').lean(),
        SubAccount.findOne({ accountCode: normalized }).select('_id tenantId').lean()
    ]);
    return [user, company, subAccount].find((doc) => doc && canonicalTenantId(doc.tenantId) !== expected) || null;
};

const resolveAccountByCode = async (code, context = null) => {
    const normalized = normalizeAccountCode(code);
    if (!/^\d{4,6}$/.test(normalized)) return null;

    const enforce = tenantGuardEnabled();
    const tenantId = enforce ? trustedRequestTenantId(context) : null;
    if (enforce && !tenantId) throw codedError('TENANT_UNRESOLVED', 503);
    const scope = enforce ? tenantMatch(tenantId) : {};

    const [user, company, subAccount, reservation] = await Promise.all([
        User.findOne({ accountCode: normalized, ...scope }),
        ClientCompany.findOne({ accountCode: normalized, ...scope }),
        SubAccount.findOne({ accountCode: normalized, ...scope }),
        AccountCode.findOne({ code: normalized, ...scope }).lean()
    ]);

    const matches = [
        user && { modelName: 'User', doc: user, label: accountLabel('User', user) },
        company && { modelName: 'ClientCompany', doc: company, label: accountLabel('ClientCompany', company) },
        subAccount && { modelName: 'SubAccount', doc: subAccount, label: accountLabel('SubAccount', subAccount) }
    ].filter(Boolean);

    if (matches.length > 1) {
        throw new Error('ACCOUNT_CODE_AMBIGUOUS');
    }
    if (matches.length === 1) return matches[0];

    if (enforce) {
        const foreign = await findForeignAccount(normalized, tenantId);
        if (foreign && foreign.tenantId) throw codedError('CROSS_TENANT_ACCOUNT', 403);
        if (foreign) throw codedError('TENANT_UNRESOLVED', 503);
    }

    if (reservation) return resolveFromReservation(reservation, normalized);
    return null;
};

module.exports = {
    CODE_LENGTHS,
    normalizeAccountCode,
    expectedUserCodeLength,
    validateAccountCode,
    ensureAccountCodeAvailable,
    reserveAccountCode,
    assignGeneratedAccountCode,
    releaseAccountCodeReservation,
    resolveAccountByCode
};
