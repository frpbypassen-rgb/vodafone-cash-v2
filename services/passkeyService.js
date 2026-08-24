'use strict';

const crypto = require('crypto');
const SecurityDevice = require('../models/SecurityDevice');

const webauthn = require('@simplewebauthn/server');

const relyingParty = (req) => {
    const configured = String(process.env.PUBLIC_APP_URL || '').trim();
    const requestOrigin = `${req.protocol}://${req.get('host')}`;
    const requestUrl = new URL(requestOrigin);
    const isLocalDevelopment = process.env.NODE_ENV !== 'production'
        && ['localhost', '127.0.0.1'].includes(requestUrl.hostname);
    const origin = !isLocalDevelopment && configured
        ? new URL(configured).origin
        : requestOrigin;
    const url = new URL(origin);
    return {
        rpID: !isLocalDevelopment && process.env.WEBAUTHN_RP_ID
            ? process.env.WEBAUTHN_RP_ID
            : url.hostname,
        origin: !isLocalDevelopment && process.env.WEBAUTHN_ORIGIN
            ? process.env.WEBAUTHN_ORIGIN
            : origin,
        rpName: process.env.WEBAUTHN_RP_NAME || 'Ahram Pay'
    };
};

const registrationOptions = async ({ req, principal, currentDevices = [] }) => {
    const rp = relyingParty(req);
    const userId = crypto.createHash('sha256')
        .update(`${principal.principalType}:${principal.principalId}`)
        .digest()
        .subarray(0, 32);
    return webauthn.generateRegistrationOptions({
        rpName: rp.rpName,
        rpID: rp.rpID,
        userName: principal.principalName || principal.principalId,
        userDisplayName: principal.principalName || 'Ahram Pay account',
        userID: userId,
        attestationType: 'none',
        timeout: 60000,
        excludeCredentials: currentDevices
            .filter((device) => device.credentialId)
            .map((device) => ({ id: device.credentialId, transports: device.credentialTransports || [] })),
        authenticatorSelection: {
            residentKey: 'preferred',
            userVerification: 'required'
        }
    });
};

const verifyRegistration = async ({ req, response, expectedChallenge }) => {
    const rp = relyingParty(req);
    return webauthn.verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserPresence: true,
        requireUserVerification: true
    });
};

const authenticationOptions = async ({ req, devices }) => {
    const rp = relyingParty(req);
    return webauthn.generateAuthenticationOptions({
        rpID: rp.rpID,
        timeout: 60000,
        userVerification: 'required',
        allowCredentials: devices
            .filter((device) => device.credentialId)
            .map((device) => ({ id: device.credentialId, transports: device.credentialTransports || [] }))
    });
};

const verifyAuthentication = async ({ req, response, expectedChallenge, device }) => {
    const rp = relyingParty(req);
    const result = await webauthn.verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        credential: {
            id: device.credentialId,
            publicKey: new Uint8Array(device.credentialPublicKey),
            counter: device.credentialCounter || 0,
            transports: device.credentialTransports || []
        },
        requireUserVerification: true
    });
    if (result.verified) {
        await SecurityDevice.updateOne(
            { _id: device._id },
            {
                $set: {
                    credentialCounter: result.authenticationInfo.newCounter,
                    lastVerifiedAt: new Date(),
                    lastSeenAt: new Date()
                }
            }
        );
    }
    return result;
};

module.exports = {
    relyingParty,
    registrationOptions,
    verifyRegistration,
    authenticationOptions,
    verifyAuthentication
};
