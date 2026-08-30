'use strict';

const bcrypt = require('bcryptjs');
const OperationPinProfile = require('../models/OperationPinProfile');

const normalizePin = (value) => String(value || '').replace(/\s/g, '');
const validPin = (value) => /^\d{4,6}$/.test(normalizePin(value));
const principalFromUser = (user = {}) => ({
    principalType: String(user.accountType || 'client_user'),
    principalId: String(user.userId || user.id || '')
});

const publicProfile = (profile) => ({
    enabled: Boolean(profile?.enabled),
    configured: Boolean(profile?.pinHash),
    lockedUntil: profile?.lockedUntil || null,
    lastChangedAt: profile?.lastChangedAt || null
});

const status = async (principal) => publicProfile(await OperationPinProfile.findOne(principal).select('+pinHash'));

// The owner can set a PIN only once, after MFA.  Any later reset/change is an
// administrator operation so a stolen session cannot lower transfer security.
const setupInitialPin = async ({ principal, pin, createdBy }) => {
    if (!validPin(pin)) {
        const error = new Error('OPERATION_PIN_INVALID');
        error.code = 'OPERATION_PIN_INVALID';
        throw error;
    }
    const existing = await OperationPinProfile.findOne(principal).select('+pinHash');
    if (existing?.pinHash) {
        const error = new Error('OPERATION_PIN_ADMIN_ONLY');
        error.code = 'OPERATION_PIN_ADMIN_ONLY';
        throw error;
    }
    const pinHash = await bcrypt.hash(normalizePin(pin), 12);
    const profile = existing || new OperationPinProfile(principal);
    profile.pinHash = pinHash;
    profile.enabled = true;
    profile.createdBy = createdBy || principal.principalId;
    profile.lastChangedBy = createdBy || principal.principalId;
    profile.lastChangedAt = new Date();
    await profile.save();
    return publicProfile(profile);
};

const adminResetPin = async ({ principal, pin, adminName, enabled = true }) => {
    if (!validPin(pin)) {
        const error = new Error('OPERATION_PIN_INVALID');
        error.code = 'OPERATION_PIN_INVALID';
        throw error;
    }
    const profile = await OperationPinProfile.findOne(principal).select('+pinHash') || new OperationPinProfile(principal);
    profile.pinHash = await bcrypt.hash(normalizePin(pin), 12);
    profile.enabled = Boolean(enabled);
    profile.lastChangedBy = adminName || 'admin';
    profile.lastChangedAt = new Date();
    profile.failedAttempts = 0;
    profile.lockedUntil = null;
    await profile.save();
    return publicProfile(profile);
};

const verifyForTransfer = async ({ principal, pin }) => {
    const profile = await OperationPinProfile.findOne(principal).select('+pinHash');
    if (!profile || !profile.enabled) return { required: false };
    if (profile.lockedUntil && profile.lockedUntil > new Date()) {
        const error = new Error('OPERATION_PIN_LOCKED'); error.code = 'OPERATION_PIN_LOCKED'; throw error;
    }
    const accepted = validPin(pin) && await bcrypt.compare(normalizePin(pin), profile.pinHash);
    if (!accepted) {
        profile.failedAttempts += 1;
        if (profile.failedAttempts >= 5) {
            profile.failedAttempts = 0;
            profile.lockedUntil = new Date(Date.now() + 10 * 60 * 1000);
        }
        await profile.save();
        const error = new Error('OPERATION_PIN_INVALID'); error.code = 'OPERATION_PIN_INVALID'; throw error;
    }
    profile.failedAttempts = 0;
    profile.lockedUntil = null;
    await profile.save();
    return { required: true };
};

module.exports = { adminResetPin, principalFromUser, setupInitialPin, status, validPin, verifyForTransfer };
