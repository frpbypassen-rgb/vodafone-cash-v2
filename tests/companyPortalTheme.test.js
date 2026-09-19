'use strict';

const {
    COMPANY_PORTAL_THEMES,
    normalizeCompanyTheme,
    resolveCompanyTheme,
    resolveAccountCompanyTheme,
    readStoredCompanyTheme,
    pharaonicIconForNav,
    pharaonicIconForService
} = require('../utils/companyPortalTheme');

describe('company portal theme helpers', () => {
    test('accepts the three official themes only', () => {
        expect(COMPANY_PORTAL_THEMES).toEqual(['day', 'night', 'pharaonic']);
        expect(normalizeCompanyTheme('day')).toBe('day');
        expect(normalizeCompanyTheme('Night')).toBe('night');
        expect(normalizeCompanyTheme('dark')).toBeNull();
        expect(normalizeCompanyTheme('')).toBeNull();
    });

    test('uses stored then server then prefers-color-scheme', () => {
        expect(resolveCompanyTheme({ stored: 'pharaonic', server: 'night', prefersDark: true })).toBe('pharaonic');
        expect(resolveCompanyTheme({ stored: null, server: 'night', prefersDark: false })).toBe('night');
        expect(resolveCompanyTheme({ prefersDark: true })).toBe('night');
        expect(resolveCompanyTheme({ prefersDark: false })).toBe('day');
        expect(resolveCompanyTheme({ stored: 'day', server: 'night', serverWins: true })).toBe('night');
        expect(resolveAccountCompanyTheme({ preferences: { companyTheme: 'pharaonic' } }, 'day')).toBe('pharaonic');
        expect(readStoredCompanyTheme({ uiTheme: 'night' })).toBe('night');
    });

    test('maps dock and service keys to Pharaonic icon ids', () => {
        expect(pharaonicIconForNav('services')).toBe('temple');
        expect(pharaonicIconForNav('smart_transfer')).toBe('ankh');
        expect(pharaonicIconForService('vodafone')).toBe('wallet');
        expect(pharaonicIconForService('bank_account')).toBe('pylon');
    });
});
