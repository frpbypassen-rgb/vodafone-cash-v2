'use strict';

require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH || '.env' });

const mongoose = require('mongoose');
const SecurityAccessRequest = require('../models/SecurityAccessRequest');
const securityControl = require('../services/securityControlService');
const { logAction } = require('../services/auditService');

const getArgument = (name) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? String(process.argv[index + 1] || '').trim() : '';
};

const requestCode = getArgument('--request-code').toUpperCase();
const confirmed = process.argv.includes('--confirm-main-device');
const rotateRecoveryCode = process.argv.includes('--rotate-recovery-code');
const enableDevicePolicies = process.argv.includes('--enable-device-policies');

const validateInputs = () => {
    if (!confirmed) {
        throw new Error('Pass --confirm-main-device to acknowledge replacement of the current web admin device.');
    }
    if (!/^SEC-[A-F0-9]{8}$/.test(requestCode)) {
        throw new Error('A valid --request-code value is required (example: SEC-12AB34CD).');
    }
    if (!process.env.MONGO_URI) {
        throw new Error('MONGO_URI is missing.');
    }
};

const authorizeAdminDevice = async () => {
    validateInputs();

    await mongoose.connect(process.env.MONGO_URI, {
        serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS) || 15000
    });

    const request = await SecurityAccessRequest.findOne({
        requestCode,
        status: 'pending'
    }).select('+deviceIdHash');

    if (!request) {
        throw new Error('The pending device request was not found. Sign in again to create a new request code.');
    }
    if (!['master_admin', 'admin'].includes(request.principalType) || request.channel !== 'web') {
        throw new Error('The request does not belong to a web administrator device.');
    }
    if (request.expiresAt <= new Date()) {
        throw new Error('The device request expired. Sign in again and use the new request code within 15 minutes.');
    }
    if (Array.isArray(request.riskSignals) && request.riskSignals.length) {
        throw new Error(`The request contains blocked risk signals: ${request.riskSignals.join(', ')}`);
    }

    const principal = {
        principalType: request.principalType,
        principalId: String(request.principalId),
        principalName: request.principalName || 'Primary administrator'
    };
    const result = await securityControl.reviewPrincipalAccessRequest({
        principal,
        requestId: request._id,
        approve: true,
        reviewedBy: 'server_operator',
        reviewNote: 'Main administrator device authorized from the production server.'
    });

    await logAction({
        action: 'SECURITY_MAIN_ADMIN_DEVICE_AUTHORIZED',
        performedByModel: 'System',
        performedByName: 'server_operator',
        targetId: result.device._id,
        targetModel: 'SecurityDevice',
        severity: 'critical',
        metadata: {
            requestCode,
            principalType: principal.principalType,
            principalId: principal.principalId,
            channel: result.device.channel
        }
    });

    console.log('Main administrator device authorization completed.');
    console.log(`Request code: ${requestCode}`);
    console.log(`Device ID: ${result.device._id}`);
    console.log('Previous active web device for this administrator was revoked.');

    if (rotateRecoveryCode) {
        const recoveryCode = await securityControl.rotateEmergencyCode('server_operator');
        console.log('');
        console.log('SAVE THIS ONE-TIME RECOVERY CODE NOW:');
        console.log(recoveryCode);
        console.log('This recovery code will not be displayed again and becomes invalid after emergency use.');
    }

    if (enableDevicePolicies) {
        const state = await securityControl.getState({ fresh: true });
        state.adminDeviceEnforcementEnabled = true;
        state.accountDeviceEnforcementEnabled = true;
        state.locationRequired = true;
        state.highConfidenceVpnBlockEnabled = true;
        state.updatedBy = 'server_operator';
        await state.save();
        securityControl.invalidateStateCache();
        console.log('Administrator and account device policies are enabled.');
        console.log('The authorized administrator must register Windows Hello/passkey in the security center.');
    }
};

authorizeAdminDevice()
    .catch((error) => {
        console.error(`Admin device authorization failed: ${error.message}`);
        process.exitCode = 1;
    })
    .finally(async () => {
        if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    });
