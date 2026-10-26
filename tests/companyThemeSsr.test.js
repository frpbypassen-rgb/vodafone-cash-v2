const { readPortalAsset } = require('./helpers/portalAssetSources');
'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const vm = require('vm');
const {
    resolveAccountCompanyTheme,
    resolveCompanyTheme,
    readStoredCompanyTheme,
    buildThemePreferenceUpdate
} = require('../utils/companyPortalTheme');

const WORKSPACE_HEAD = path.join(__dirname, '..', 'views', 'company', 'partials', 'head.ejs');
const WORKSPACE_VIEW = path.join(__dirname, '..', 'views', 'company', 'workspace.ejs');

describe('company theme SSR and preferences', () => {
    test.each([['day', 'company'], ['night', 'company'], ['day', 'agent'], ['night', 'agent']])('keeps the %s %s portal usable when browser storage is blocked', async (theme, type) => {
        const head = await ejs.renderFile(type === 'agent' ? path.join(__dirname, '../views/agent/partials/head.ejs') : WORKSPACE_HEAD, {
            page: 'smart_transfer',
            pageMeta: { title: 'التحويل الذكي' },
            workspace: { type, isCompany: type === 'company', isAgent: type === 'agent' },
            companyTheme: theme, clientTheme: type === 'agent' ? theme : undefined
        });
        const attributes = {};
        const context = {
            localStorage: {
                getItem() { throw new Error('Storage blocked'); },
                setItem() { throw new Error('Storage blocked'); }
            },
            window: { matchMedia: () => ({ matches: false }) },
            document: {
                documentElement: { dataset: {}, setAttribute: (key, value) => { attributes[key] = value; } },
                querySelector: () => null
            }
        };
        expect(() => vm.runInNewContext(head.match(/<script>([\s\S]*?)<\/script>/)[1], context)).not.toThrow();
        expect(attributes['data-theme']).toBe(theme);
        expect(attributes['data-portal']).toBe(type);
    });
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
            companyThemeMeta: { themeColor: '#0B1426' }
        }, { filename: WORKSPACE_HEAD });

        expect(head).toContain('/css/portal-shell/tokens.css');
        expect(head).toContain('/css/portal-shell/layout.css');
        expect(head).toContain('/css/portal-shell/theme-day.css');
        expect(head).toContain('/css/portal-shell/theme-night.css');
        expect(head).toContain('/css/portal-shell/theme-pharaonic.css');
        expect(head).not.toContain('client-company-os.css');
        expect(head).toContain('valid.includes(server) ? server');
        expect(head).toContain('ahram_company_theme');
    });

    test('workspace document paints the server theme and role before scripts', async () => {
        const html = fs.readFileSync(WORKSPACE_VIEW, 'utf8');
        expect(html).toContain('data-company-role=');
        expect(html).toContain('data-theme="<%= businessTheme %>"');
        expect(html).toContain('data-company-shell');
    });

    test('theme files stay split and Pharaonic art is lazy plus motion-safe', () => {
        const day = readPortalAsset(path.join(__dirname, '..', 'public/css/company-portal-theme-day.css'));
        const night = readPortalAsset(path.join(__dirname, '..', 'public/css/company-portal-theme-night.css'));
        const pharaonic = readPortalAsset(path.join(__dirname, '..', 'public/css/company-portal-theme-pharaonic.css'));
        const layout = readPortalAsset(path.join(__dirname, '..', 'public/css/company-portal-layout.css'));
        expect(day).toContain('#0F766E');
        expect(day).toContain('#E7F1F6');
        expect(night).toContain('#0B1426');
        expect(night).toContain('#38BDF8');
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
