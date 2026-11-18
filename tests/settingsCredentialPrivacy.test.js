'use strict';

jest.mock('../models/User', () => ({ find: jest.fn(), findByIdAndUpdate: jest.fn() }));
jest.mock('../models/ClientEmployee', () => ({ find: jest.fn(), findByIdAndUpdate: jest.fn() }));
jest.mock('../models/ClientBot', () => ({ find: jest.fn() }));
jest.mock('../services/passwordService', () => ({ hashPassword: jest.fn().mockResolvedValue('NEW-TEST-HASH') }));
jest.mock('../services/auditService', () => ({ logAction: jest.fn() }));
jest.mock('../services/whatsappService', () => ({}));
jest.mock('../services/receiptShareService', () => ({}));
jest.mock('../services/rateChangeService', () => ({}));

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ejs = require('ejs');
const express = require('express');
const request = require('supertest');
const User = require('../models/User');
const Employee = require('../models/ClientEmployee');
const Company = require('../models/ClientBot');
const { hashPassword } = require('../services/passwordService');
const router = require('../routes/settings');
const viewPath = path.join(__dirname, '../views/settings_clients_web.ejs');
const source = () => fs.readFileSync(viewPath, 'utf8');
const secrets = ['USER-TEST-PASSWORD-HASH', 'EMPLOYEE-TEST-PASSWORD-HASH', 'TEST-OTP-SECRET', 'COMPANY-TEST-TOKEN', 'FUTURE-TEST-CREDENTIAL'];
const unsafeName = '<img src=x onerror="globalThis.compromised=true">';
const user = { _id: 'user-test', name: 'Client', phone: '01000000000', status: 'active', webUsername: "client'quoted", webPassword: secrets[0], otpCode: secrets[2], futureCredential: secrets[4] };
const employee = { _id: 'employee-test', name: unsafeName, role: 'employee', status: 'active', companyId: { _id: 'company-test', name: 'Company', token: secrets[3] }, webUsername: "employee'quoted", webPassword: secrets[1], otpCode: secrets[2], futureCredential: secrets[4] };
const query = (data) => ({ select() { return this; }, populate() { return this; }, then(resolve, reject) { return Promise.resolve(data).then(resolve, reject); } });
let app, captured;

beforeEach(() => {
    jest.clearAllMocks();
    User.find.mockImplementation(() => query([user]));
    Employee.find.mockImplementation(() => query([employee]));
    Company.find.mockImplementation(() => query([{ _id: 'company-test', name: 'Company', token: secrets[3] }]));
    User.findByIdAndUpdate.mockResolvedValue({});
    Employee.findByIdAndUpdate.mockResolvedValue({});
    app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use((req, res, next) => {
        req.session = { isLoggedIn: true, adminRole: 'master' };
        res.render = (_view, data) => {
            captured = data;
            return res.send(ejs.render(source(), { ...data, include: () => '' }, { filename: viewPath }));
        };
        next();
    });
    app.use('/settings', router);
    app.use((error, _req, res, _next) => res.status(500).send(error.stack));
});

test('account management excludes passwords, OTPs and nested company tokens from HTML and view data', async () => {
    const response = await request(app).get('/settings/clients-web');
    expect(response.status).toBe(200);
    for (const secret of secrets) {
        expect(response.text).not.toContain(secret);
        expect(JSON.stringify(captured)).not.toContain(secret);
    }
    expect(captured.allClientEmployees[0]).toMatchObject({ _id: 'employee-test', name: unsafeName, companyId: 'company-test' });
    expect(captured.webEmployees[0]).not.toHaveProperty('webPassword');
    expect(captured.webUsers[0]).not.toHaveProperty('webPassword');
    expect(response.text).not.toContain('onclick="openEditModal(');
    expect(response.text).toContain('data-web-username="client&#39;quoted"');
});

test.each(['user', 'employee'])('an empty replacement password preserves the %s hash', async (accountType) => {
    const response = await request(app).post('/settings/clients-web/edit').type('form')
        .send({ accountType, accountId: 'account-test', webUsername: 'Updated.Name', webPassword: '' });
    expect(response.status).toBe(302);
    expect(hashPassword).not.toHaveBeenCalled();
    const model = accountType === 'user' ? User : Employee;
    expect(model.findByIdAndUpdate).toHaveBeenCalledWith('account-test', { webUsername: 'updated.name' });
});

test.each(['user', 'employee'])('a supplied replacement password still updates the %s through hashing', async (accountType) => {
    const response = await request(app).post('/settings/clients-web/edit').type('form')
        .send({ accountType, accountId: 'account-test', webUsername: 'Updated.Name', webPassword: 'new test password' });
    expect(response.status).toBe(302);
    expect(hashPassword).toHaveBeenCalledWith('new test password');
    const model = accountType === 'user' ? User : Employee;
    expect(model.findByIdAndUpdate).toHaveBeenCalledWith('account-test', { webUsername: 'updated.name', webPassword: 'NEW-TEST-HASH' });
});

test('employee dropdown uses text options and supports canonical and legacy company links', async () => {
    const response = await request(app).get('/settings/clients-web');
    const data = [...captured.allClientEmployees,
        { _id: 'legacy-test', name: 'Legacy', role: 'accountant', clientBotId: 'company-test' }];
    const options = [];
    const select = { required: false, replaceChildren() { options.length = 0; }, add(option) { options.push(option); } };
    let innerHtmlWrites = 0;
    Object.defineProperty(select, 'innerHTML', { set() { innerHtmlWrites++; } });
    const elements = { companySelect: { value: 'company-test' }, employeeSelect: select };
    const script = [...response.text.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
    const context = { document: { getElementById: id => elements[id], querySelectorAll: () => [] },
        Option: function(text, value) { this.text = text; this.value = value; } };
    // Execute only the dropdown function from the actual template, with browser
    // primitives substituted so an HTML sink write is observable.
    const fn = script.slice(script.indexOf('function updateEmployeeDropdown()'), script.indexOf('function toggleType()'));
    vm.runInNewContext('const allEmployees = ' + JSON.stringify(data) + ';' + fn + ';updateEmployeeDropdown();', context);
    expect(innerHtmlWrites).toBe(0);
    expect(options.map(option => option.text)).toContain(unsafeName + ' (موظف)');
    expect(options.map(option => option.value)).toEqual(['', 'employee-test', 'legacy-test']);
});

test('opening an edit clears the optional password field', async () => {
    const response = await request(app).get('/settings/clients-web');
    const script = [...response.text.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
    const elements = Object.fromEntries(['editAccountType', 'editAccountId', 'editWebUsername', 'editWebPassword'].map(id => [id, { value: 'previous-input' }]));
    const context = { document: { getElementById: id => elements[id], querySelectorAll: () => [] }, bootstrap: { Modal: function() { this.show = () => {}; } } };
    const start = script.indexOf('function openEditModal(');
    const end = script.indexOf('\n    }', start) + 6;
    vm.runInNewContext(script.slice(start, end) + ';openEditModal("user","id","quoted\\\'name","old-secret");', context);
    expect(elements.editWebPassword.value).toBe('');
    expect(response.text).toMatch(/id="editWebPassword"[^>]*type="password"|type="password"[^>]*id="editWebPassword"/);
    expect(response.text.match(/<input[^>]*id="editWebPassword"[^>]*>/)[0]).not.toMatch(/\brequired\b/);
});
