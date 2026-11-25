'use strict';

// Exercise the real local Express route and demo Mongo data. Never use on production.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const signature = require('cookie-signature');
const { MongoStore } = require('connect-mongo');

const origin = 'http://127.0.0.1:4577';
const mongoUrl = 'mongodb://127.0.0.1:27017/ahram_company_mobile_demo_v2';
const executorId = process.env.LOCAL_DEMO_EXECUTOR_ID || '28012d79cbdcb51d0147b6a7';
const secretFile = path.join(os.tmpdir(), 'ahram-local-demo-4577-session-secret.txt');
const expected = {
    ledger: ['كشف الحساب', 'حركة الرصيد'],
    deposits: ['سجل الإيداعات', 'id="settlementForm"'],
    operations: ['سجل التنفيذ', 'العمليات'],
    staff: ['حسابات الفريق', 'توزيع الرصيد'],
    settings: ['الإعدادات والصلاحيات', 'id="toggleForm"']
};

async function run() {
    assert.match(executorId, /^[a-f\d]{24}$/i, 'A local demo executor ID is required');
    const secret = fs.readFileSync(secretFile, 'utf8').trim();
    assert.ok(secret.length >= 32, 'Local demo session secret is missing');
    const store = MongoStore.create({ mongoUrl, autoRemove: 'disabled' });
    const sid = crypto.randomBytes(24).toString('hex');
    const cookie = `ahram.sid=${encodeURIComponent(`s:${signature.sign(sid, secret)}`)}`;
    const session = {
        cookie: { originalMaxAge: 3600000, expires: new Date(Date.now() + 3600000), httpOnly: true, path: '/', sameSite: 'lax', secure: false },
        isLoggedIn: true, adminRole: 'master', adminName: 'فحص محلي مؤقت', adminId: 'master_admin'
    };
    try {
        await new Promise((resolve, reject) => store.set(sid, session, error => error ? reject(error) : resolve()));
        for (const [tab, markers] of Object.entries(expected)) {
            const response = await fetch(`${origin}/executor/${executorId}?tab=${tab}`, {
                headers: { cookie, accept: 'text/html' }, redirect: 'manual', signal: AbortSignal.timeout(20000)
            });
            const html = await response.text();
            const found = markers.map(marker => html.includes(marker));
            const result = { tab, status: response.status, redirect: response.headers.get('location'), markers: found };
            process.stdout.write(`${JSON.stringify(result)}\n`);
            assert.equal(response.status, 200, `${tab} did not render`);
            assert.ok(found.every(Boolean), `${tab} rendered the wrong section`);
        }
    } finally {
        await new Promise((resolve, reject) => store.destroy(sid, error => error ? reject(error) : resolve()));
        await store.close();
    }
}

run().catch(error => { console.error(error.message); process.exitCode = 1; });
