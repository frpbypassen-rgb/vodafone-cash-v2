'use strict';

const RegistrationRequest = require('../models/RegistrationRequest');
const User = require('../models/User');
const SubAccount = require('../models/SubAccount');
const ClientEmployee = require('../models/ClientEmployee');
const AgentEmployee = require('../models/AgentEmployee');
const Employee = require('../models/Employee');
const Admin = require('../models/Admin');

const PENDING_STATUSES = Object.freeze(['pending', 'pending_agent']);

const identityModels = Object.freeze([
    { modelName: 'User', label: 'عميل أو وكيل', Model: User, canBeDeleted: true },
    { modelName: 'SubAccount', label: 'حساب عميل تابع', Model: SubAccount, canBeDeleted: true },
    { modelName: 'ClientEmployee', label: 'حساب شركة', Model: ClientEmployee, canBeDeleted: true },
    { modelName: 'AgentEmployee', label: 'حساب موظف وكيل', Model: AgentEmployee, canBeDeleted: true },
    { modelName: 'Employee', label: 'حساب منفذ', Model: Employee, canBeDeleted: false },
    { modelName: 'Admin', label: 'حساب إدارة', Model: Admin, canBeDeleted: false, usernameOnly: true }
]);

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cleanIdentityValue = (value) => String(value || '').trim();
const sameIdentityValue = (left, right) => cleanIdentityValue(left).toLowerCase() === cleanIdentityValue(right).toLowerCase();

const identityFieldQueries = ({ phone, username, includeArchived = true, usernameOnly = false }) => {
    const queries = [];
    const normalizedPhone = cleanIdentityValue(phone);
    const normalizedUsername = cleanIdentityValue(username);

    if (!usernameOnly && normalizedPhone) {
        queries.push(includeArchived
            ? { $or: [{ phone: normalizedPhone }, { 'deletedCredentials.phone': normalizedPhone }] }
            : { phone: normalizedPhone });
    }
    if (normalizedUsername) {
        const usernameRegex = new RegExp(`^${escapeRegex(normalizedUsername)}$`, 'i');
        queries.push(includeArchived
            ? { $or: [{ webUsername: usernameRegex }, { 'deletedCredentials.webUsername': usernameRegex }] }
            : { webUsername: usernameRegex });
    }

    return queries;
};

const requestIdentityConditions = ({ phone, username }) => {
    const conditions = [];
    const normalizedPhone = cleanIdentityValue(phone);
    const normalizedUsername = cleanIdentityValue(username);
    if (normalizedPhone) conditions.push({ phone: normalizedPhone }, { companyPhone: normalizedPhone });
    if (normalizedUsername) conditions.push({ username: new RegExp(`^${escapeRegex(normalizedUsername)}$`, 'i') });
    return conditions;
};

const findIdentityMatches = async (descriptor, identity, deleted) => {
    const fieldQueries = identityFieldQueries({
        ...identity,
        includeArchived: deleted,
        usernameOnly: descriptor.usernameOnly
    });
    if (!fieldQueries.length) return [];

    const documents = await Promise.all(fieldQueries.map((identityQuery) => {
        const query = descriptor.canBeDeleted
            ? { $and: [identityQuery, { status: deleted ? 'deleted' : { $ne: 'deleted' } }] }
            : identityQuery;
        return descriptor.Model.findOne(query);
    }));

    const seen = new Set();
    return documents.filter((document) => {
        if (!document) return false;
        const id = String(document._id || `${document.phone}:${document.webUsername}`);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
    });
};

const summarizeDeletedMatch = ({ descriptor, document }) => ({
    modelName: descriptor.modelName,
    accountId: document._id,
    accountName: document.name || document.webUsername || document.phone || descriptor.label,
    accountTypeLabel: descriptor.label,
    deletedAt: document.deletedAt || null
});

const inspectRegistrationIdentity = async ({ phone, username, excludeRequestId = null }) => {
    const identity = {
        phone: cleanIdentityValue(phone),
        username: cleanIdentityValue(username)
    };
    const pendingConditions = requestIdentityConditions(identity);
    const pendingFilter = {
        status: { $in: PENDING_STATUSES },
        ...(pendingConditions.length ? { $or: pendingConditions } : {})
    };
    if (excludeRequestId) pendingFilter._id = { $ne: excludeRequestId };

    const pendingPromise = pendingConditions.length
        ? RegistrationRequest.findOne(pendingFilter)
        : Promise.resolve(null);
    const activePromises = identityModels.map(async (descriptor) => (
        (await findIdentityMatches(descriptor, identity, false)).map((document) => ({ descriptor, document }))
    ));
    const deletedPromises = identityModels
        .filter((descriptor) => descriptor.canBeDeleted)
        .map(async (descriptor) => (
            (await findIdentityMatches(descriptor, identity, true)).map((document) => ({ descriptor, document }))
        ));

    const [pendingRequest, activeCandidates, deletedCandidates] = await Promise.all([
        pendingPromise,
        Promise.all(activePromises),
        Promise.all(deletedPromises)
    ]);

    return {
        identity,
        pendingRequest,
        activeMatches: activeCandidates.flat(),
        deletedMatches: deletedCandidates.flat()
    };
};

const previousDeletedAccountNote = (deletedMatches) => {
    if (!deletedMatches.length) return '';
    const labels = [...new Set(deletedMatches.map(({ descriptor }) => descriptor.label))].join('، ');
    return `ملاحظة تلقائية: سبق حذف حساب يستخدم رقم الهاتف أو اسم المستخدم نفسه (${labels}). تم السماح بإرسال طلب جديد ويجب مراجعته قبل التفعيل.`;
};

const buildPreviousDeletedMetadata = (inspection) => {
    if (!inspection.deletedMatches.length) {
        return { wasPreviouslyDeleted: false, previousDeletedAccounts: [] };
    }

    return {
        wasPreviouslyDeleted: true,
        previousDeletedAccounts: inspection.deletedMatches.map(summarizeDeletedMatch),
        adminNotes: previousDeletedAccountNote(inspection.deletedMatches)
    };
};

const checkRegistrationIdentityAvailability = async ({ phone, username, excludeRequestId = null }) => {
    const inspection = await inspectRegistrationIdentity({ phone, username, excludeRequestId });
    if (inspection.pendingRequest) {
        return {
            success: false,
            reason: 'pending',
            message: `يوجد طلب تسجيل سابق بهذه البيانات برقم مرجعي: ${inspection.pendingRequest.refCode}. يرجى انتظار المراجعة.`,
            inspection
        };
    }
    if (inspection.activeMatches.length) {
        return {
            success: false,
            reason: 'active',
            message: 'رقم الهاتف أو اسم المستخدم مسجل في حساب قائم. يرجى تسجيل الدخول أو استخدام بيانات أخرى.',
            inspection
        };
    }

    return {
        success: true,
        reason: null,
        message: '',
        inspection,
        requestMetadata: buildPreviousDeletedMetadata(inspection)
    };
};

const archiveDeletedMatchCredentials = async ({ match, phone, username }) => {
    const { descriptor, document } = match;
    const id = String(document._id);
    const updates = {};
    const normalizedPhone = cleanIdentityValue(phone);
    const normalizedUsername = cleanIdentityValue(username);

    if (normalizedPhone && sameIdentityValue(document.phone, normalizedPhone)) {
        updates['deletedCredentials.phone'] = document.deletedCredentials?.phone || document.phone;
        updates.phone = `deleted-${descriptor.modelName.toLowerCase()}-${id}`;
    }
    if (normalizedUsername && sameIdentityValue(document.webUsername, normalizedUsername)) {
        updates['deletedCredentials.webUsername'] = document.deletedCredentials?.webUsername || document.webUsername;
        updates.webUsername = `deleted.${descriptor.modelName.toLowerCase()}.${id}@archive.invalid`;
    }

    if (!Object.keys(updates).length) return false;
    await descriptor.Model.updateOne(
        { _id: document._id, status: 'deleted' },
        { $set: updates },
        { strict: false }
    );
    return true;
};

const prepareRegistrationIdentityForApproval = async ({ phone, username, excludeRequestId }) => {
    const availability = await checkRegistrationIdentityAvailability({ phone, username, excludeRequestId });
    if (!availability.success) {
        const error = new Error(availability.reason === 'pending' ? 'IDENTITY_PENDING' : 'IDENTITY_TAKEN');
        error.identityResult = availability;
        throw error;
    }

    await Promise.all(availability.inspection.deletedMatches.map((match) => (
        archiveDeletedMatchCredentials({
            match,
            phone: availability.inspection.identity.phone,
            username: availability.inspection.identity.username
        })
    )));

    return availability;
};

module.exports = {
    PENDING_STATUSES,
    inspectRegistrationIdentity,
    buildPreviousDeletedMetadata,
    checkRegistrationIdentityAvailability,
    prepareRegistrationIdentityForApproval
};
