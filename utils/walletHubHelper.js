'use strict';

/**
 * Customer web portal only (direct clients + sub_clients).
 * Agents, company workspace, and executor flows use separate UIs — do not route them here.
 */
function isWalletHubSession(accountType, role) {
    if (accountType === 'sub_client') return true;
    if (accountType === 'user' && role !== 'agent') return true;
    return false;
}

function canRequestRetailDeposit(accountType, role) {
    // Direct retail clients fund via central admin. Agency sub-clients are
    // funded by their agent; those deposits stay out of the admin directory.
    return accountType === 'user' && role !== 'agent';
}

function walletHubViewFlags(req, account = {}) {
    const walletHub = isWalletHubSession(req.session?.accountType, account.role);
    return {
        walletHub,
        user: account,
        isSystemOpen: typeof account.isSystemOpen === 'boolean' ? account.isSystemOpen : true
    };
}

module.exports = { isWalletHubSession, canRequestRetailDeposit, walletHubViewFlags };
