'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

describe('executor settings mobile workspace', () => {
    test('renders account-first tabs and compact content', () => {
        const file = path.join(root, 'views/executor/settings.ejs');
        const view = read('views/executor/settings.ejs');
        expect(() => ejs.compile(view, { filename: file })).not.toThrow();
        const tabs = ['account', 'team', 'notifications', 'security'];
        const positions = tabs.map((tab) => view.indexOf(`data-settings-tab="${tab}"`));
        expect(positions.every((position) => position >= 0)).toBe(true);
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
        expect(view).toContain('id="settingsProfileForm"');
        expect(view).toContain('id="settingsPasswordForm"');
        expect(view).toContain('id="settingsAccountOverview"');
        expect(view).not.toContain('id="pushStep1"');
        expect(view).not.toContain('id="pushLearnToggle"');
        expect(read('public/css/executor-settings.css')).toContain('.settings-mobile-tabs { position: sticky');
    });

    test('account mutations are authenticated and password attempts limited', () => {
        const routes = read('routes/executorPortal.js');
        expect(routes).toContain("router.patch('/api/settings/profile', requireExecutorAuth");
        expect(routes).toContain("router.post('/api/settings/password', requireExecutorAuth, settingsPasswordLimiter");
        const controller = read('controllers/executorDashboardController.js');
        expect(controller).toContain('bcrypt.compare(currentPassword, employee.webPassword');
        expect(controller).toContain('newPassword !== confirmPassword');
        expect(controller).toContain('normalizeExecutorPhone(req.body?.phone)');
    });

    test('authenticator QR stays in the browser and sessions show recorded location only', () => {
        const mfa = read('views/partials/mfa_security_panel.ejs');
        expect(mfa).toContain('new window.QRCode(qr, { text: data.setup.qrUri');
        const sessions = read('views/account_security_sessions.ejs');
        expect(sessions).toContain('approximateLocation(device.lastLocation)');
        expect(sessions).toContain("'غير متوفر'");
    });
});
