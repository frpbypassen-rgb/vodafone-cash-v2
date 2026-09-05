'use strict';

const User = require('../models/User');
const SubAccount = require('../models/SubAccount');
const ClientCompany = require('../models/ClientCompany');
const Settings = require('../models/Settings');
const { isWalletHubSession } = require('../utils/walletHubHelper');
const { buildPendingRateAlertForClient } = require('../services/rateAlerts/rateAlertAudienceService');
const { getServiceRatesForTier } = require('../utils/rateHelper');
const { applyCustomerRateMargins } = require('../utils/agencyPricing');

async function loadWalletHubAccount(req) {
    if (!req.session?.isClientLoggedIn || !req.session.clientId) return null;

    const accountType = req.session.accountType;
    let account = null;
    let isSubAccount = false;

    if (accountType === 'sub_client') {
        account = await SubAccount.findById(req.session.clientId).lean();
        isSubAccount = true;
    } else if (accountType === 'user') {
        account = await User.findById(req.session.clientId).lean();
    }

    if (!account || account.status !== 'active') return null;
    if (!isWalletHubSession(accountType, account.role)) return null;

    return { account, accountType, isSubAccount };
}

async function buildClientProfile(req, account, isSubAccount) {
    let accountTypeName = 'عميل مباشر';
    let accountTypeDetail = '';
    let userRoleLabel = 'عميل فردي';
    let profileMaster = null;

    if (isSubAccount) {
        accountTypeName = 'عميل تابع';
        profileMaster = account.masterType === 'user'
            ? await User.findById(account.masterId).lean()
            : await ClientCompany.findById(account.masterId).lean();
        accountTypeDetail = profileMaster ? profileMaster.name : 'غير معروف';
        userRoleLabel = 'نقطة بيع فرعية';
    } else if (account.role === 'accountant') {
        userRoleLabel = 'محاسب';
    }

    const currentHour = new Date().getHours();
    const isSystemOpen = currentHour >= 8 && currentHour < 23;

    return {
        name: account.name,
        phone: account.phone || 'غير مسجل',
        username: account.webUsername,
        accountCode: account.accountCode || '',
        agentAccountCode: isSubAccount && profileMaster && profileMaster.role === 'agent'
            ? (profileMaster.agentCode || profileMaster.accountCode || '')
            : '',
        address: account.address
            || (account.businessProfile && (account.businessProfile.address || account.businessProfile.city))
            || 'غير مسجل',
        joinedAt: account.createdAt,
        accountStatus: account.status || 'active',
        profilePhotoUpdatedAt: account.profilePhotoUpdatedAt || null,
        hasProfilePhoto: Boolean(account.profilePhotoKey),
        canEditProfile: req.session.accountType === 'user' || isSubAccount,
        systemStatus: isSystemOpen ? 'تعمل' : 'خارج أوقات العمل',
        accountTypeName,
        accountTypeDetail,
        userRoleLabel,
        mfaEnabled: Boolean(account.mfaEnabled)
    };
}

async function buildHubRenderContext(req) {
    const loaded = await loadWalletHubAccount(req);
    if (!loaded) return null;

    const { account, accountType, isSubAccount } = loaded;
    const settings = await Settings.findOne({}).lean() || {};
    const profile = await buildClientProfile(req, account, isSubAccount);
    const masterRates = getServiceRatesForTier(Number(account.tier || 1), settings);
    const serviceRates = isSubAccount
        ? applyCustomerRateMargins(masterRates, account)
        : masterRates;
    const currentRate = serviceRates.vodafone;
    const pendingRateUpdate = await buildPendingRateAlertForClient({
        accountType,
        clientId: req.session.clientId,
        settings
    });

    const currentHour = new Date().getHours();
    const isSystemOpen = currentHour >= 8 && currentHour < 23;
    const canViewBalance = true;
    const canRequestDeposit = accountType === 'user' && account.role !== 'agent';

    return {
        account,
        user: {
            name: account.name,
            phone: account.phone || account.webUsername,
            balance: Number(account.balance || 0),
            role: account.role || 'user',
            accountType,
            accountCode: account.accountCode,
            canViewBalance
        },
        accountType,
        isSubAccount,
        profile,
        walletHub: true,
        isSystemOpen,
        serviceRates,
        currentRate,
        pendingRateUpdate,
        canRequestDeposit,
        csrfToken: req.session?.csrfToken || ''
    };
}

module.exports = {
    loadWalletHubAccount,
    buildClientProfile,
    buildHubRenderContext
};
