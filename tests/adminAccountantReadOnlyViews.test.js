'use strict';

const path = require('node:path');
const ejs = require('ejs');
const { adminHrefVisible } = require('../config/adminRoles');

const render = (name, values) => ejs.renderFile(path.join(__dirname, '..', 'views', name), {
    role: 'accountant',
    adminName: 'محاسب تجريبي',
    csrfToken: 'test-csrf',
    adminHrefVisible: href => adminHrefVisible('accountant', href),
    ...values
});

describe('accountant read-only detail screens', () => {
    test('executor directory hides creation and registration controls', async () => {
        const html = await render('executors.ejs', {
            bots: [], archivedBots: [], isMaster: false, query: {},
            executorRegistrationUrl: 'https://example.test/executor-portal/register',
            executorLoginUrl: 'https://example.test/login',
            executorServiceOptions: [], apiProviderPresets: []
        });
        expect(html).toContain('منفذو وبوتات التنفيذ');
        expect(html).toContain('للعرض فقط');
        expect(html).not.toContain('id="createExecutorModal"');
        expect(html).not.toContain('روابط التسجيل والدخول');
    });

    test('account directory keeps navigation and search without financial actions', async () => {
        const html = await render('clients.ejs', {
            users: [], companies: [], agents: [], subAccounts: [],
            activeSection: 'users', activeStatus: 'all', search: '', query: {}, isMaster: false,
            directoryCounts: { users: 0, companies: 0, agents: 0, total: 0 },
            pagination: { page: 1, totalPages: 1, totalItems: 0, startItem: 0, endItem: 0 }
        });
        expect(html).toContain('دليل الحسابات');
        expect(html).toContain('action="/clients"');
        expect(html).not.toContain('إيداع / خصم');
        expect(html).not.toContain('href="/registration-requests"');
    });

    test('account details show stored values and history without mutation controls', async () => {
        const html = await render('accountant_account_detail.ejs', {
            account: { _id: 'a1', name: 'حساب تجريبي', status: 'active', balance: 125, accountCode: '123456', phone: '0910000000' },
            kind: 'user',
            transactions: [{ _id: 't1', customId: 'ATT-TEST', status: 'completed', amount: 40, costLYD: 9, createdAt: new Date('2026-11-24T10:00:00Z') }]
        });
        expect(html).toContain('حساب تجريبي');
        expect(html).toContain('ATT-TEST');
        expect(html).toContain('للعرض فقط');
        expect(html).not.toMatch(/<form\b[^>]*method=["']POST/i);
        expect(html).not.toContain('/settings');
        expect(html).not.toContain('/transactions/operations');
        expect(html).not.toContain('إيداع / خصم');
    });

    test('API executor details use saved provider state without test or financial buttons', async () => {
        const html = await render('accountant_executor_detail.ejs', {
            bot: { _id: 'e1', name: 'منفذ تجريبي', status: 'active', isApiBot: true, apiProviderKey: 'kenan', lastApiServiceCredit: 75 },
            history: { rows: [{ _id: 't2', customId: 'API-TEST', status: 'completed', amount: 100, at: new Date('2026-11-24T10:00:00Z') }], page: 1, totalPages: 1 }
        });
        expect(html).toContain('منفذ تجريبي');
        expect(html).toContain('API-TEST');
        expect(html).toContain('آخر رصيد محفوظ');
        expect(html).not.toMatch(/<form\b[^>]*method=["']POST/i);
        expect(html).not.toContain('اختبار اتصال المزود');
        expect(html).not.toContain('إلغاء ورد الرصيد');
        expect(html).not.toContain('إيداع / خصم');
    });
});
