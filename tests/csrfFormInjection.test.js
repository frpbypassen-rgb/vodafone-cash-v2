'use strict';

const express = require('express');
const request = require('supertest');
const ejs = require('ejs');
const path = require('path');
const csrfProtection = require('../middlewares/csrfProtection');

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use((req, _res, next) => {
    req.session = { csrfToken: 'local-csrf-test-token' };
    next();
});
app.use(csrfProtection);
app.get('/forms', (_req, res) => res.type('html').send(`
    <form action="/first" method="POST"><button>First</button></form>
    <form action="/second" method="POST"><input type="hidden" name="_csrf" value="local-csrf-test-token"><button>Second</button></form>
    <form action="/third" method="post"><button>Third</button></form>
`));
app.post(['/first', '/second', '/third'], (_req, res) => res.json({ success: true }));

test('every POST form receives its own session token and existing tokens are not duplicated', async () => {
    const page = await request(app).get('/forms');
    expect(page.status).toBe(200);
    const forms = page.text.match(/<form\b[\s\S]*?<\/form>/gi) || [];
    expect(forms).toHaveLength(3);
    for (const form of forms) {
        expect((form.match(/name="_csrf"/g) || []).length).toBe(1);
        expect(form).toContain('value="local-csrf-test-token"');
    }
    expect((await request(app).post('/first').type('form').send({ _csrf: 'local-csrf-test-token' })).status).toBe(200);
    expect((await request(app).post('/first').type('form').send({})).status).toBe(403);
});

test('the executor interface toggle carries the page session token explicitly', async () => {
    const html = await ejs.renderFile(
        path.join(__dirname, '..', 'views', 'partials', 'admin_executor_employee_policies.ejs'),
        {
            isMaster: true,
            bot: { _id: 'group-1', isApiBot: false, isManagerBot: false },
            teamEmployees: [{ _id: 'operator-1', name: 'Demo', role: 'operator', webUsername: 'demo@example.test', simpleTaskViewEnabled: false }],
            csrfToken: 'local-csrf-test-token'
        }
    );
    const toggleForm = html.match(/<form[^>]*\/simple-view[^>]*>[\s\S]*?<\/form>/i)?.[0];
    expect(toggleForm).toContain('name="_csrf" value="local-csrf-test-token"');
    expect(toggleForm).toContain('name="enabled" value="true"');
});
