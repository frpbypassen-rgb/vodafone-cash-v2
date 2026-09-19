'use strict';

const bcrypt = require('bcryptjs');
const { logAction } = require('./auditService');
const {
    resolveCanonicalRole,
    assertCapability,
    assertNotSelf
} = require('./companyAccessService');

const RESET_CONFIRM_PHRASE = 'RESET';
const MIN_PASSWORD_LENGTH = 8;

const containsPassword = (value) => {
    if (!value || typeof value !== 'object') return false;
    return Object.keys(value).some((key) => /^(password|passwd|webPassword|newPassword|currentPassword|confirmPassword|secret)$/i.test(key));
};

const assertAuditSafe = (payload) => {
    if (containsPassword(payload) || containsPassword(payload?.metadata)
        || containsPassword(payload?.oldData) || containsPassword(payload?.newData)) {
        throw new Error('PASSWORD_LEAK_FORBIDDEN');
    }
};

const confirmStaffPasswordReset = ({ confirmPhrase, confirmUsername, targetUsername }) => {
    const phrase = String(confirmPhrase || '').trim();
    const typedUsername = String(confirmUsername || '').trim().toLowerCase();
    const expectedUsername = String(targetUsername || '').trim().toLowerCase();
    if (phrase !== RESET_CONFIRM_PHRASE || !expectedUsername || typedUsername !== expectedUsername) {
        const error = new Error('RESET_CONFIRM_REQUIRED');
        error.statusCode = 403;
        error.code = 'RESET_CONFIRM_REQUIRED';
        throw error;
    }
};

const bumpSessionVersion = (account) => {
    account.sessionVersion = Number(account.sessionVersion || 0) + 1;
    return account.sessionVersion;
};

const applyOwnPasswordChange = async ({ actor, currentPassword, newPassword, passwordConfirm, req, portal = 'company' }) => {
    if (!actor || !await bcrypt.compare(String(currentPassword || ''), actor.webPassword || '')) {
        const error = new Error('CURRENT_PASSWORD');
        error.statusCode = 403;
        error.code = 'CURRENT_PASSWORD';
        throw error;
    }
    if (String(newPassword || '').length < MIN_PASSWORD_LENGTH || String(newPassword) !== String(passwordConfirm || '')) {
        const error = new Error('NEW_PASSWORD');
        error.statusCode = 400;
        error.code = 'NEW_PASSWORD';
        throw error;
    }
    actor.webPassword = newPassword;
    actor.mustChangePassword = false;
    bumpSessionVersion(actor);
    await actor.save();
    const audit = {
        action: 'USER_PASSWORD_CHANGED',
        req,
        performedById: actor._id,
        performedByModel: 'ClientEmployee',
        performedByName: actor.name,
        targetId: actor._id,
        targetModel: 'ClientEmployee',
        result: 'ناجح',
        metadata: { selfService: true, portal, sessionInvalidated: true }
    };
    assertAuditSafe(audit);
    await logAction(audit);
    return { sessionVersion: actor.sessionVersion };
};

const applyStaffPasswordReset = async ({
    actor,
    access,
    company,
    target,
    newPassword,
    confirmPhrase,
    confirmUsername,
    req
}) => {
    assertCapability(access, 'canResetStaffPassword');
    assertNotSelf(actor._id, target._id);
    if (resolveCanonicalRole(target) === 'owner') {
        const error = new Error('FORBIDDEN');
        error.statusCode = 403;
        error.code = 'FORBIDDEN';
        throw error;
    }
    confirmStaffPasswordReset({
        confirmPhrase,
        confirmUsername,
        targetUsername: target.webUsername
    });
    if (String(newPassword || '').length < MIN_PASSWORD_LENGTH) {
        const error = new Error('NEW_PASSWORD');
        error.statusCode = 400;
        error.code = 'NEW_PASSWORD';
        throw error;
    }

    target.webPassword = newPassword;
    target.mustChangePassword = true;
    bumpSessionVersion(target);
    await target.save();

    const audit = {
        action: 'USER_PASSWORD_CHANGED',
        req,
        performedById: actor._id,
        performedByModel: 'ClientEmployee',
        performedByName: actor.name,
        targetId: target._id,
        targetModel: 'ClientEmployee',
        result: 'ناجح',
        companyId: company._id,
        metadata: {
            companyId: String(company._id),
            webUsername: target.webUsername,
            temporaryPassword: true,
            sessionInvalidated: true
        }
    };
    assertAuditSafe(audit);
    await logAction(audit);
    return { sessionVersion: target.sessionVersion, mustChangePassword: true };
};

module.exports = {
    RESET_CONFIRM_PHRASE,
    MIN_PASSWORD_LENGTH,
    confirmStaffPasswordReset,
    applyOwnPasswordChange,
    applyStaffPasswordReset,
    bumpSessionVersion,
    assertAuditSafe
};
