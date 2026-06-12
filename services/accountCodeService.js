'use strict';

const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const SubAccount = require('../models/SubAccount');
const AccountCode = require('../models/AccountCode');

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

const reserveAccountCode = async (code, current) => {
    const normalized = normalizeAccountCode(code);
    try {
        return await AccountCode.findOneAndUpdate(
            { ownerModel: current.modelName, ownerId: current.id },
            { $set: { code: normalized, ownerModel: current.modelName, ownerId: current.id } },
            { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
        );
    } catch (error) {
        if (error.code === 11000) throw duplicateReservationError();
        throw error;
    }
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

const resolveAccountByCode = async (code) => {
    const normalized = normalizeAccountCode(code);
    if (!/^\d{4,6}$/.test(normalized)) return null;

    const [user, company, subAccount, reservation] = await Promise.all([
        User.findOne({ accountCode: normalized }),
        ClientCompany.findOne({ accountCode: normalized }),
        SubAccount.findOne({ accountCode: normalized }),
        AccountCode.findOne({ code: normalized }).lean()
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
    releaseAccountCodeReservation,
    resolveAccountByCode
};
