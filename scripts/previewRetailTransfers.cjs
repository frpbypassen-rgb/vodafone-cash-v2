'use strict';
// Local rendering harness: no database, application startup, financial workers or credentials.
const express = require('express');
const path = require('node:path');
const { SERVICE_CATALOG, STATUS_META, findServiceByToken } = require('../services/portalWorkspace/catalog');
const { parseTransferMessage } = require('../utils/smartTransferParser');
const root = path.join(__dirname, '..');
const app = express();
app.set('views', path.join(root, 'views'));
app.set('view engine', 'ejs');
app.use(express.json());
app.use(express.static(path.join(root, 'public')));
const rates = {
    vodafone: 10,
    bank_account: 9.9,
    post_account: 9.95,
    post_card: 9.85,
    sefa_niger: 0.01,
    bankak_sudan: 250,
};
const user = {
    _id: 'demo-customer',
    name: 'أحمد محمد — حساب تجريبي',
    phone: '0911111111',
    accountCode: '10482',
    balance: 2485,
    role: 'user',
};
const base = {
    account: user,
    user,
    accountType: 'user',
    clientTheme: 'day',
    csrfToken: 'preview-only',
    localPreview: true,
    serviceRates: rates,
    serviceCatalog: SERVICE_CATALOG.map((s) => ({ ...s, rate: rates[s.key] })),
    workspace: {
        type: 'customer',
        isCompany: false,
        isAgent: false,
        isRetail: true,
        entity: user,
        actor: user,
        permissions: { canTransfer: true, canViewBalance: true },
    },
    statusMeta: STATUS_META,
    transferHub: { suggestedReasons: [], recentOperations: [] },
};
const page = (name) => (req, res) => {
    const selected = findServiceByToken(req.params.serviceKey) || SERVICE_CATALOG[0];
    res.render('client/retail_transfers', {
        ...base,
        page: name,
        servicePage: { selectedService: selected.key, isolated: true },
        selectedService: selected,
    });
};
app.get(['/', '/client/transfers', '/client/services'], page('services'));
app.get('/client/services/:serviceKey', page('service_workbench'));
app.get('/client/smart-transfer', page('smart_transfer'));
app.get('/client/internal-transfer', page('internal_transfer'));
app.get('/client/api/rates', (_req, res) => res.json({ success: true, serviceRates: rates }));
app.get('/security/operation-pin/status', (_req, res) => res.json({ success: true, enabled: false }));
app.post('/client/api/smart-transfer/parse', (req, res) =>
    res.json({ success: true, parsed: parseTransferMessage(String(req.body.message || '').slice(0, 2000)) })
);
app.post('/client/balance-transfer/lookup', (_req, res) =>
    res.json({ success: true, target: { accountCode: '10483', name: 'محمد علي — بيانات تجريبية' } })
);
app.get('/client/api/notifications', (_req, res) =>
    res.json({ success: true, notifications: [], unreadCount: 0 })
);
app.post(/.*/, (_req, res) =>
    res
        .status(403)
        .json({ success: false, error: 'هذه معاينة محلية؛ إرسال التحويلات وتعديل الحساب محجوبان.' })
);
app.get(/.*/, (_req, res) =>
    res
        .status(200)
        .send(
            '<html lang="ar" dir="rtl"><meta charset="utf-8"><p>هذه معاينة لصفحات التحويلات الفعلية. بقية الصفحات تُراجع في مرحلة لاحقة.</p><a href="/client/transfers">العودة للتحويلات</a></html>'
        )
);
app.listen(4595, '127.0.0.1', () =>
    console.log(
        'Retail transfer view preview: http://127.0.0.1:4595/client/transfers — all financial submissions disabled'
    )
);
