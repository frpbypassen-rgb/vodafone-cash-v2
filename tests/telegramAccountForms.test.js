'use strict';

const fs = require('fs');
const path = require('path');

const view = fs.readFileSync(path.join(__dirname, '../views/admin_account_edit.ejs'), 'utf8');
const routes = fs.readFileSync(path.join(__dirname, '../routes/adminAccounts.js'), 'utf8');

test('Telegram forms are outside the account editor form', () => {
    const mainStart = view.indexOf('<form class="editor-form"');
    const mainEnd = view.indexOf('</form>', mainStart);
    expect(view.slice(mainStart + 6, mainEnd)).not.toContain('<form');
    expect(view.indexOf('<form id="telegram-settings-form"')).toBeGreaterThan(mainEnd);
    expect(view.indexOf('<form id="telegram-code-form"')).toBeGreaterThan(mainEnd);
    expect(view).toContain('form="telegram-settings-form"');
    expect(view).toContain('form="telegram-code-form"');
});

test('Generated codes stay in session and return to the editor', () => {
    expect(routes).toContain('req.session.telegramCodeFlash =');
    expect(routes).toContain('delete req.session.telegramCodeFlash');
    expect(routes).not.toContain('telegramCode=${');
    expect(view).toContain('<%= optionalTelegramCode %>');
    expect(view).toContain("typeof telegramCode !== 'undefined'");
});
