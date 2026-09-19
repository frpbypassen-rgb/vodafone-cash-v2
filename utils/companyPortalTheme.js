'use strict';

const COMPANY_PORTAL_THEMES = Object.freeze(['day', 'night', 'pharaonic']);

const COMPANY_PORTAL_THEME_META = Object.freeze({
    day: Object.freeze({
        key: 'day',
        label: 'نهاري',
        description: 'واجهة نهارية فاتحة بتباين عالٍ',
        themeColor: '#F4F6F8',
        colorScheme: 'light'
    }),
    night: Object.freeze({
        key: 'night',
        label: 'ليلي',
        description: 'حجر داكن وإضاءة منخفضة',
        themeColor: '#12110F',
        colorScheme: 'dark'
    }),
    pharaonic: Object.freeze({
        key: 'pharaonic',
        label: 'فرعوني',
        description: 'هوية فرعونية كاملة بالرمل والذهب والفيروز',
        themeColor: '#1A1510',
        colorScheme: 'dark'
    })
});

const COMPANY_PORTAL_THEME_STORAGE_KEY = 'ahram_company_theme';

const COMPANY_PHARAONIC_ICONS = Object.freeze({
    overview: 'pyramid',
    services: 'temple',
    smart_transfer: 'ankh',
    internal_transfer: 'was',
    transactions: 'papyrus',
    staff: 'people',
    deposits: 'column',
    finance: 'balance',
    reports: 'obelisk',
    team_reports: 'obelisk',
    settings: 'scarab',
    security: 'wedjat',
    support: 'wedjat'
});

const SERVICE_PHARAONIC_ICONS = Object.freeze({
    vodafone: 'wallet',
    post_account: 'column',
    post_card: 'cartouche',
    bank_account: 'pylon',
    sefa_niger: 'sun',
    bankak_sudan: 'was'
});

const normalizeCompanyTheme = (value) => {
    const theme = String(value || '').trim().toLowerCase();
    return COMPANY_PORTAL_THEMES.includes(theme) ? theme : null;
};

const readStoredCompanyTheme = (account) => (
    normalizeCompanyTheme(account?.preferences?.companyTheme)
    || normalizeCompanyTheme(account?.uiTheme)
);

const resolveAccountCompanyTheme = (account, sessionTheme) => (
    readStoredCompanyTheme(account)
    || normalizeCompanyTheme(sessionTheme)
    || 'day'
);

// After login the server value is authoritative. localStorage is only an
// instant-paint hint when the account has not yet stored a preference.
const resolveCompanyTheme = ({ stored, server, prefersDark, serverWins = false } = {}) => {
    if (serverWins) {
        return normalizeCompanyTheme(server)
            || normalizeCompanyTheme(stored)
            || (prefersDark ? 'night' : 'day');
    }
    return normalizeCompanyTheme(stored)
        || normalizeCompanyTheme(server)
        || (prefersDark ? 'night' : 'day');
};

const buildThemePreferenceUpdate = (theme) => ({
    'preferences.companyTheme': theme
});

const pharaonicIconForNav = (key) => COMPANY_PHARAONIC_ICONS[key] || 'temple';
const pharaonicIconForService = (key) => SERVICE_PHARAONIC_ICONS[key] || 'wallet';

module.exports = {
    COMPANY_PORTAL_THEMES,
    COMPANY_PORTAL_THEME_META,
    COMPANY_PORTAL_THEME_STORAGE_KEY,
    COMPANY_PHARAONIC_ICONS,
    SERVICE_PHARAONIC_ICONS,
    normalizeCompanyTheme,
    readStoredCompanyTheme,
    resolveAccountCompanyTheme,
    resolveCompanyTheme,
    buildThemePreferenceUpdate,
    pharaonicIconForNav,
    pharaonicIconForService
};
