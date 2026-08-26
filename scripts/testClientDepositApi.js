'use strict';

const fs = require('fs');
const path = require('path');

const BASE = process.env.TEST_BASE_URL || 'http://127.0.0.1:3002';
const OUT_DIR = path.join(process.cwd(), 'artifacts', 'client-deposit-test', new Date().toISOString().replace(/[:.]/g, '-'));
const CLIENT = { username: 'client.direct', password: '12345678' };
const ADMIN = { username: 'admin', password: 'admin123' };

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }

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
        headers: { ...(jar ? { Cookie: cookieHeader(jar) } : {}), Accept: 'application/json', ...headers },
        body,
        redirect: 'manual'
    });
    const text = await response.text();
    let json = {};
    try { json = JSON.parse(text); } catch (_) { json = { raw: text.slice(0, 500) }; }
    return { response, json, text };
}

async function login(jar, creds) {
    const loginPage = await fetch(`${BASE}/login`);
    const loginHtml = await loginPage.text();
    parseSetCookie(loginPage.headers.getSetCookie?.() || []).forEach((v, k) => jar.set(k, v));
    const loginCsrf = (loginHtml.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1] || '';
    const loginBody = new URLSearchParams({
        username: creds.username,
        password: creds.password,
        _csrf: loginCsrf,
        latitude: '32.8872',
        longitude: '13.1913',
        locationAccuracy: '50'
    });
    const login = await fetch(`${BASE}/login`, {
        method: 'POST',
        headers: {
            Cookie: cookieHeader(jar),
            'Content-Type': 'application/x-www-form-urlencoded',
            Origin: BASE,
            Referer: `${BASE}/login`,
            'x-client-latitude': '32.8872',
            'x-client-longitude': '13.1913',
            'x-client-location-accuracy': '50'
        },
        body: loginBody.toString(),
        redirect: 'manual'
    });
    parseSetCookie(login.headers.getSetCookie?.() || []).forEach((v, k) => jar.set(k, v));
    return { status: login.status, location: login.headers.get('location') };
}

function extractCsrf(html) {
    return (html.match(/const csrfToken = "([^"]+)"/) || html.match(/name="_csrf"\s+value="([^"]+)"/) || [])[1] || '';
}

async function main() {
    ensureDir(OUT_DIR);
    const log = [];
    const clientJar = new Map();
    const adminJar = new Map();

    log.push({ step: 'client-login', ...(await login(clientJar, CLIENT)) });

    const depositsPage = await fetch(`${BASE}/client/deposits`, { headers: { Cookie: cookieHeader(clientJar) } });
    const html = await depositsPage.text();
    fs.writeFileSync(path.join(OUT_DIR, 'deposits-page.html'), html);
    const csrfToken = extractCsrf(html);
    log.push({ step: 'deposits-page', status: depositsPage.status, hasForm: html.includes('depositForm'), hasCsrf: Boolean(csrfToken) });

    const create = await fetchJson(`${BASE}/client/api/deposits`, {
        jar: clientJar,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': csrfToken,
            Origin: BASE,
            Referer: `${BASE}/client/deposits`
        },
        body: JSON.stringify({ amount: 250, note: 'تحويل بنكي تجريبي CLDEP-TEST' })
    });
    log.push({ step: 'create-deposit', status: create.response.status, body: create.json });

    const list = await fetchJson(`${BASE}/client/api/deposits`, { jar: clientJar });
    const pendingRequest = (list.json.requests || []).find((r) => r.status === 'pending');
    log.push({ step: 'list-deposits', status: list.response.status, count: list.json.requests?.length, pendingId: pendingRequest?.customId });

    log.push({ step: 'admin-login', ...(await login(adminJar, ADMIN)) });

    const tickets = await fetchJson(`${BASE}/api/support/tickets?status=active&category=deposit&search=CLDEP`, { jar: adminJar });
    let clientTicket = (tickets.json.tickets || []).find((t) => String(t.lastMessagePreview || '').includes('CLDEP') || String(t.category || '') === 'deposit');
    if (!clientTicket && create.json.request?.customId) {
        const byRef = await fetchJson(`${BASE}/api/support/tickets?search=${encodeURIComponent(create.json.request.customId)}`, { jar: adminJar });
        clientTicket = (byRef.json.tickets || [])[0];
    }
    if (!clientTicket && pendingRequest?.customId) {
        const byRef = await fetchJson(`${BASE}/api/support/tickets?search=${encodeURIComponent(pendingRequest.customId)}`, { jar: adminJar });
        clientTicket = (byRef.json.tickets || [])[0];
    }
    log.push({ step: 'find-ticket', found: Boolean(clientTicket), ticketId: clientTicket?._id, ticketCount: tickets.json.tickets?.length });

    if (clientTicket?._id) {
        const supportPage = await fetch(`${BASE}/support`, { headers: { Cookie: cookieHeader(adminJar) } });
        const supportHtml = await supportPage.text();
        const adminCsrf = extractCsrf(supportHtml);
        const approve = await fetchJson(`${BASE}/api/support/tickets/${clientTicket._id}/client-deposit/approve`, {
            jar: adminJar,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-csrf-token': adminCsrf,
                Origin: BASE,
                Referer: `${BASE}/support`
            },
            body: JSON.stringify({})
        });
        log.push({ step: 'approve-deposit', status: approve.response.status, body: approve.json });

        const afterList = await fetchJson(`${BASE}/client/api/deposits`, { jar: clientJar });
        const approved = (afterList.json.requests || []).find((r) => r.customId === (create.json.request?.customId || pendingRequest?.customId));
        log.push({
            step: 'verify-approved',
            status: approved?.status,
            balance: afterList.json.balance
        });
    }

    fs.writeFileSync(path.join(OUT_DIR, 'result.json'), JSON.stringify(log, null, 2));
    console.log(JSON.stringify(log, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
