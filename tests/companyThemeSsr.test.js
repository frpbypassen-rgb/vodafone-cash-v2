'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const {
    resolveAccountCompanyTheme,
    resolveCompanyTheme,
    readStoredCompanyTheme,
    buildThemePreferenceUpdate
} = require('../utils/companyPortalTheme');

const WORKSPACE_HEAD = path.join(__dirname, '..', 'views', 'client', 'partials', 'workspace_head.ejs');
const WORKSPACE_VIEW = path.join(__dirname, '..', 'views', 'client', 'workspace.ejs');

describe('company theme SSR and preferences', () => {
    test('reads preferences.companyTheme and aliases legacy uiTheme', () => {
        expect(readStoredCompanyTheme({ preferences: { companyTheme: 'night' }, uiTheme: 'day' })).toBe('night');
        expect(readStoredCompanyTheme({ uiTheme: 'pharaonic' })).toBe('pharaonic');
        expect(resolveAccountCompanyTheme({ preferences: { companyTheme: 'day' } }, 'night')).toBe('day');
        expect(buildThemePreferenceUpdate('night')).toEqual({ 'preferences.companyTheme': 'night' });
    });

    test('server value wins after login', () => {
        expect(resolveCompanyTheme({
            stored: 'pharaonic',
            server: 'night',
            serverWins: true
        })).toBe('night');
        expect(resolveCompanyTheme({
            stored: 'pharaonic',
            server: 'night',
            serverWins: false
        })).toBe('pharaonic');
    });

    test('shell HTML sets theme, role, and stylesheets without JavaScript', async () => {
        const head = await ejs.renderFile(WORKSPACE_HEAD, {
            pageMeta: { title: 'معرض الخدمات' },
            workspace: { isCompany: true, persona: 'manager' },
            companyTheme: 'night',
            companyThemeMeta: { themeColor: '#12110F' }
        }, { filename: WORKSPACE_HEAD });

        expect(head).toContain('/css/company-portal.tokens.css');
        expect(head).toContain('/css/company-portal-layout.css');
        expect(head).toContain('/css/company-portal-theme-day.css');
        expect(head).toContain('/css/company-portal-theme-night.css');
        expect(head).toContain('/css/company-portal-theme-pharaonic.css');
        expect(head).not.toContain('client-company-os.css');
        expect(head).toContain('valid.includes(server) ? server');
        expect(head).toContain('ahram_company_theme');
    });

    test('workspace document paints the server theme and role before scripts', async () => {
        const html = fs.readFileSync(WORKSPACE_VIEW, 'utf8');
        expect(html).toContain('data-company-role=');
        expect(html).toContain('data-theme="<%= typeof companyTheme !== \'undefined\' && companyTheme ? companyTheme : \'day\' %>"');
        expect(html).toContain('data-company-shell');
    });

    test('theme files stay split and Pharaonic art is lazy plus motion-safe', () => {
        const day = fs.readFileSync(path.join(__dirname, '..', 'public/css/company-portal-theme-day.css'), 'utf8');
        const night = fs.readFileSync(path.join(__dirname, '..', 'public/css/company-portal-theme-night.css'), 'utf8');
        const pharaonic = fs.readFileSync(path.join(__dirname, '..', 'public/css/company-portal-theme-pharaonic.css'), 'utf8');
        const layout = fs.readFileSync(path.join(__dirname, '..', 'public/css/company-portal-layout.css'), 'utf8');
        expect(day).toContain('#F4F6F8');
        expect(night).toContain('#12110F');
        expect(pharaonic).toContain('#E8D5B7');
        expect(pharaonic).toContain('#C9A227');
        expect(pharaonic).toContain('#1A1510');
        expect(pharaonic).toContain('cp-art-ready');
        expect(pharaonic).toContain('prefers-reduced-motion');
        expect(layout).toContain('--cp-touch');
        expect(layout).toContain('overflow-x: hidden');
        expect(layout).not.toMatch(/url\(['"][^)]+\.(png|jpe?g|webp)/i);
    });
});
