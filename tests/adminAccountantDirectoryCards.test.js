'use strict';

const path = require('node:path');
const ejs = require('ejs');

test('accountant sees account details without finance or action menus', async () => {
    const html = await ejs.renderFile(path.join(__dirname, '../views/partials/admin_merchant_list.ejs'), {
        activeSection: 'users',
        companies: [],
        agents: [],
        users: [{ _id: 'demo', name: 'حساب تجريبي', status: 'active', balance: 25, accountCode: '12345', phone: '0910000000' }],
        isMaster: false,
        role: 'accountant'
    });
    expect(html).toContain('href="/user/demo"');
    expect(html).not.toContain('am-card-finance');
    expect(html).not.toContain('am-actions');
    expect(html).not.toContain('الموظفون');
    expect(html).not.toContain('تعديل البيانات');
});
