'use strict';

const CLIENT_PORTAL_THEMES = Object.freeze(['day', 'night', 'pharaonic']);

const CLIENT_PORTAL_THEME_META = Object.freeze({
    day: Object.freeze({
        key: 'day',
        label: 'نهاري',
        description: 'واجهة عملاء ملوّنة بنيلي وفيروز',
        themeColor: '#E8EEFA',
        colorScheme: 'light'
    }),
    night: Object.freeze({
        key: 'night',
        label: 'ليلي',
        description: 'وضع عمليات داكن بتباين عالٍ',
        themeColor: '#070B14',
        colorScheme: 'dark'
    }),
    pharaonic: Object.freeze({
        key: 'pharaonic',
        label: 'فرعوني',
        description: 'رمل وذهب وفيروز ليوم العمل',
        themeColor: '#1C1610',
        colorScheme: 'dark'
    })
});

const CLIENT_PORTAL_THEME_STORAGE_KEY = 'ahram_client_theme';

const normalizeClientTheme = (value) => {
    const theme = String(value || '').trim().toLowerCase();
    return CLIENT_PORTAL_THEMES.includes(theme) ? theme : null;
};

const readStoredClientTheme = (account) => (
    normalizeClientTheme(account?.preferences?.clientTheme)
);

const resolveAccountClientTheme = (account, sessionTheme) => (
    readStoredClientTheme(account)
    || normalizeClientTheme(sessionTheme)
    || 'day'
);

// After login the server value is authoritative. localStorage is only an
// instant-paint hint when the account has not yet stored a preference.
const resolveClientTheme = ({ stored, server, prefersDark, serverWins = false } = {}) => {
    if (serverWins) {
        return normalizeClientTheme(server)
            || normalizeClientTheme(stored)
            || (prefersDark ? 'night' : 'day');
    }
    return normalizeClientTheme(stored)
        || normalizeClientTheme(server)
        || (prefersDark ? 'night' : 'day');
};

const buildClientThemePreferenceUpdate = (theme) => ({
    'preferences.clientTheme': theme
});

const clientThemeLocals = (account, sessionTheme) => {
    const clientTheme = resolveAccountClientTheme(account, sessionTheme);
    return {
        clientTheme,
        clientThemeMeta: CLIENT_PORTAL_THEME_META[clientTheme]
    };
};

module.exports = {
    CLIENT_PORTAL_THEMES,
    CLIENT_PORTAL_THEME_META,
    CLIENT_PORTAL_THEME_STORAGE_KEY,
    normalizeClientTheme,
    readStoredClientTheme,
    resolveAccountClientTheme,
    resolveClientTheme,
    buildClientThemePreferenceUpdate,
    clientThemeLocals
};
