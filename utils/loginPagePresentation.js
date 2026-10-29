'use strict';
const loginPagePresentation = (req, data, now = Date.now()) => {
    const challenge = Boolean(data.accountMfaChallenge || data.executorMfaChallenge);
    const pending = data.accountMfaChallenge
        ? req?.session?.pendingAccountMfaLogin : req?.session?.pendingExecutorMfaLogin;
    const location = req?.session?.pendingSecurityLocation;
    const fresh = pending && Number(pending.createdAt) <= now && now - Number(pending.createdAt) <= 300000;
    const valid = location && Number.isFinite(location.latitude) && Math.abs(location.latitude) <= 90
        && Number.isFinite(location.longitude) && Math.abs(location.longitude) <= 180;
    return {
        view: challenge ? 'client/authenticator_verify' : 'unified_login',
        location: challenge && fresh && valid ? location : null
    };
};
module.exports = loginPagePresentation;
