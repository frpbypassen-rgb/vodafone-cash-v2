'use strict';

require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });

const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const Admin = require('../models/Admin');
const SecurityDevice = require('../models/SecurityDevice');
const SecurityAccessRequest = require('../models/SecurityAccessRequest');
const SecurityState = require('../models/SecurityState');

const getArgument = (name) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
};

const username = getArgument('--username').toLowerCase();
const confirmLockdown = process.argv.includes('--confirm-lockdown');
const password = String(process.env.ADMIN_ROTATION_PASSWORD || '');

const fail = (message) => {
    console.error(`Admin rotation failed: ${message}`);
    process.exitCode = 1;
};

const validateInputs = () => {
    if (!confirmLockdown) {
        throw new Error('Pass --confirm-lockdown to acknowledge removal of other admin accounts and all active sessions.');
    }
    if (!/^[a-z0-9._@-]{4,80}$/i.test(username)) {
        throw new Error('A valid --username value is required.');
    }
    if (password.length < 14) {
        throw new Error('ADMIN_ROTATION_PASSWORD must contain at least 14 characters.');
    }
    if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
        throw new Error('ADMIN_ROTATION_PASSWORD must contain upper-case, lower-case, and numeric characters.');
    }
    if (!process.env.MONGO_URI) {
        throw new Error('MONGO_URI is missing.');
    }
};

const rotateAdminCredentials = async () => {
    validateInputs();

    const passwordHash = await bcrypt.hash(password, 12);
    const emergencyCode = `AHRAM-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const emergencyCodeHash = await bcrypt.hash(emergencyCode, 12);
    delete process.env.ADMIN_ROTATION_PASSWORD;

    await mongoose.connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 15000
    });

    const dbSession = await mongoose.startSession();
    let removedAdmins = 0;
    let removedSessions = 0;
    let targetId = null;

    try {
        await dbSession.withTransaction(async () => {
            const admins = await Admin.find({}).sort({ createdAt: 1 }).session(dbSession);
            const exact = admins.find((admin) => String(admin.webUsername || '').toLowerCase() === username);
            const master = admins.find((admin) => admin.role === 'master');
            const target = exact || master || admins[0] || null;

            if (target) {
                targetId = target._id;
                const removal = await Admin.deleteMany(
                    { _id: { $ne: target._id } },
                    { session: dbSession }
                );
                removedAdmins = removal.deletedCount || 0;
                await Admin.updateOne(
                    { _id: target._id },
                    {
                        $set: {
                            name: target.name || 'Primary administrator',
                            role: 'master',
                            webUsername: username,
                            webPassword: passwordHash,
                            status: 'active',
                            permissions: ['*'],
                            mustEnrollSecurity: true,
                            mfaEnabled: false,
                            mfaType: 'none',
                            totpSecretEncrypted: '',
                            mfaRecoveryCodeHashes: [],
                            mfaConfiguredAt: null,
                            mfaLastUsedStep: null
                        },
                        $inc: { sessionVersion: 1 }
                    },
                    { session: dbSession }
                );
            } else {
                const created = await Admin.create([{
                    name: 'Primary administrator',
                    role: 'master',
                    webUsername: username,
                    webPassword: passwordHash,
                    status: 'active',
                    permissions: ['*'],
                    mustEnrollSecurity: true,
                    mfaEnabled: false,
                    mfaType: 'none',
                    totpSecretEncrypted: '',
                    mfaRecoveryCodeHashes: [],
                    mfaConfiguredAt: null,
                    mfaLastUsedStep: null
                }], { session: dbSession });
                targetId = created[0]._id;
            }

            await SecurityDevice.updateMany(
                { principalType: { $in: ['master_admin', 'admin'] } },
                {
                    $set: {
                        status: 'revoked',
                        revokedAt: new Date(),
                        revokedReason: 'primary_admin_security_reinitialized'
                    }
                },
                { session: dbSession }
            );
            await SecurityAccessRequest.updateMany(
                { principalType: { $in: ['master_admin', 'admin'] }, status: 'pending' },
                {
                    $set: {
                        status: 'rejected',
                        reviewedAt: new Date(),
                        reviewedBy: 'admin_rotation',
                        reviewNote: 'Superseded by primary administrator security initialization.'
                    }
                },
                { session: dbSession }
            );
            await SecurityState.findOneAndUpdate(
                { key: 'global' },
                {
                    $set: {
                        adminDeviceEnforcementEnabled: false,
                        accountDeviceEnforcementEnabled: true,
                        adminPermissionEnforcementEnabled: true,
                        locationRequired: true,
                        highConfidenceVpnBlockEnabled: true,
                        adminSessionHours: 12,
                        accountSessionHours: 12,
                        emergencyCodeHash,
                        emergencyCodeRotatedAt: new Date(),
                        updatedBy: 'primary_admin_security_initialization'
                    },
                    $inc: { emergencyCodeVersion: 1 },
                    $setOnInsert: { key: 'global' }
                },
                { upsert: true, session: dbSession, setDefaultsOnInsert: true }
            );

            const sessionCollection = mongoose.connection.db.collection('sessions');
            const sessionRemoval = await sessionCollection.deleteMany({}, { session: dbSession });
            removedSessions = sessionRemoval.deletedCount || 0;
        });
    } finally {
        await dbSession.endSession();
    }

    console.log('Admin credential rotation completed.');
    console.log(`Admin ID: ${targetId}`);
    console.log(`Username: ${username}`);
    console.log(`Other admin accounts removed: ${removedAdmins}`);
    console.log(`Active sessions invalidated: ${removedSessions}`);
    console.log('Account device protection: ENABLED');
    console.log('Administrator device protection: PENDING PASSKEY ENROLLMENT');
    console.log('Administrator Authenticator state: RESET FOR SECURE RE-ENROLLMENT');
    console.log('Emergency recovery code (shown once; store it offline):');
    console.log(emergencyCode);
    console.log('Next step: sign in on the main device, allow location, then register Windows Hello from /admin/security.');
    console.log('Password was not printed or written to the repository.');
};

rotateAdminCredentials()
    .catch((error) => fail(error.message))
    .finally(async () => {
        delete process.env.ADMIN_ROTATION_PASSWORD;
        if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    });
