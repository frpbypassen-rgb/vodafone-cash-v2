'use strict';

const fs = require('fs');
const path = require('path');

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3002';
const OUT_DIR = path.join(process.cwd(), 'artifacts', 'executor-deposit-test', new Date().toISOString().replace(/[:.]/g, '-'));
const MANAGER = {
    username: 'local_exec_manager@ahram.com',
    password: 'DemoManager2026!'
};

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function parseSetCookie(setCookieHeaders = []) {
    const jar = new Map();
    setCookieHeaders.forEach((header) => {
        const [pair] = String(header).split(';');
        const idx = pair.indexOf('=');
        if (idx > 0) jar.set(pair.slice(0, idx), pair.slice(idx + 1));
    });
    return jar;
}

function cookieHeader(jar) {
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function fetchJson(url, { jar, method = 'GET', headers = {}, body = undefined } = {}) {
    const response = await fetch(url, {
        method,
        headers: {
            ...(jar ? { Cookie: cookieHeader(jar) } : {}),
            Accept: 'application/json',
            ...headers
        },
        body,
        redirect: 'manual'
    });
    const text = await response.text();
    let json = {};
    try { json = JSON.parse(text); } catch (_) { json = { raw: text.slice(0, 500) }; }
    return { response, json, text };
}

async function main() {
    ensureDir(OUT_DIR);
    const log = [];
    const jar = new Map();

    const loginPage = await fetch(`${BASE}/login`);
    const loginHtml = await loginPage.text();
    parseSetCookie(loginPage.headers.getSetCookie?.() || []).forEach((v, k) => jar.set(k, v));
    const loginCsrfMatch = loginHtml.match(/name="_csrf"\s+value="([^"]+)"/);
    const loginCsrf = loginCsrfMatch ? loginCsrfMatch[1] : '';
    log.push({ step: 'login-page', status: loginPage.status, hasLoginCsrf: Boolean(loginCsrf) });

    const loginBody = new URLSearchParams({
        username: MANAGER.username,
        password: MANAGER.password,
        _csrf: loginCsrf
    });
    const login = await fetchJson(`${BASE}/login`, {
        jar,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: loginBody.toString()
    });
    parseSetCookie(login.response.headers.getSetCookie?.() || []).forEach((v, k) => jar.set(k, v));
    log.push({ step: 'login-post', status: login.response.status, location: login.response.headers.get('location') });

    const depositsPage = await fetch(`${BASE}/executor-portal/deposits`, {
        headers: { Cookie: cookieHeader(jar) }
    });
    const html = await depositsPage.text();
    fs.writeFileSync(path.join(OUT_DIR, 'deposits-page.html'), html);
    log.push({
        step: 'deposits-page',
        status: depositsPage.status,
        hasReceiptInput: html.includes('id="depositReceipts"'),
        hasDropZone: html.includes('drop-zone'),
        hasReceiptsBase64: html.includes('receiptsBase64')
    });

    const csrfMatch = html.match(/window\.executorCsrfToken\s*=\s*"([^"]+)"/);
    const csrfToken = csrfMatch ? csrfMatch[1] : '';
    log.push({ step: 'csrf', hasToken: Boolean(csrfToken) });

    const tinyPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8BQz0AEYBxVSF+FABJADveWkH6AAAAAAElFTkSuQmCC';
    const depositPayload = {
        amount: 2750,
        note: 'اختبار محلي API - مرجع 445566',
        receiptsBase64: [tinyPng]
    };

    const deposit = await fetchJson(`${BASE}/executor-portal/api/deposits`, {
        jar,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': csrfToken
        },
        body: JSON.stringify(depositPayload)
    });
    log.push({ step: 'deposit-post', status: deposit.response.status, body: deposit.json });

    const list = await fetchJson(`${BASE}/executor-portal/api/deposits`, { jar });
    log.push({ step: 'deposit-list', status: list.response.status, count: Array.isArray(list.json.requests) ? list.json.requests.length : 0, first: list.json.requests?.[0] || null });

    const ok = depositsPage.status === 200
        && html.includes('id="depositReceipts"')
        && deposit.response.status === 201
        && deposit.json.success === true
        && Number(deposit.json.request?.receiptCount || 0) >= 1;

    fs.writeFileSync(path.join(OUT_DIR, 'result.json'), JSON.stringify({ ok, log }, null, 2));
    console.log(JSON.stringify({ ok, outDir: OUT_DIR, log }, null, 2));
    if (!ok) process.exitCode = 1;
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
