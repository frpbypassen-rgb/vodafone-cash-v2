'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const { loadPuppeteer } = require('../utils/puppeteerLoader');

dotenv.config();

const repoRoot = path.resolve(__dirname, '..');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.join(repoRoot, 'artifacts', 'deposit-e2e', stamp);
const screenshotsDir = path.join(runDir, 'screenshots');
const port = Number(process.env.E2E_PORT || 3347);

const adminUsername = `deposit.admin.${Date.now()}@ahram.test`;
const adminPassword = 'DepositTest#200104';
const clientUsername = `deposit.client.${Date.now()}@ahram.test`;
const clientPassword = 'ClientDeposit#200104';
const clientPhone = `091${String(Date.now()).slice(-7)}`;
const depositAmount = 125.75;

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function buildTestMongoUri(baseUri, dbName) {
    if (!baseUri || baseUri === 'demo' || baseUri === 'DEMO') {
        throw new Error('MONGO_URI must point to a real MongoDB server for this E2E test.');
    }

    try {
        const url = new URL(baseUri);
        url.pathname = `/${dbName}`;
        url.searchParams.set('retryWrites', 'false');
        return url.toString();
    } catch (_) {
        const nextUri = baseUri.replace(/\/([^/?]+)?(\?.*)?$/, `/${dbName}$2`);
        return nextUri.includes('?') ? `${nextUri}&retryWrites=false` : `${nextUri}?retryWrites=false`;
    }
}

async function waitForHealth(baseUrl, timeoutMs = 45000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        try {
            const response = await fetch(`${baseUrl}/health`);
            if (response.ok) return;
        } catch (_) {}
        await new Promise((resolve) => setTimeout(resolve, 750));
    }
    throw new Error('Timed out waiting for local app health check.');
}

async function seedDatabase(testMongoUri) {
    await mongoose.connect(testMongoUri, { serverSelectionTimeoutMS: 30000, retryWrites: false });

    const Admin = require('../models/Admin');
    const User = require('../models/User');
    const Settings = require('../models/Settings');

    await Settings.create({});
    const admin = await Admin.create({
        name: 'Deposit E2E Admin',
        role: 'admin',
        webUsername: adminUsername,
        webPassword: adminPassword
    });

    const client = await User.create({
        name: 'Deposit E2E Client',
        phone: clientPhone,
        webUsername: clientUsername,
        webPassword: clientPassword,
        status: 'active',
        balance: 0,
        tier: 1,
        accountCode: String(Date.now()).slice(-4)
    });

    await mongoose.disconnect();
    return { adminId: String(admin._id), clientId: String(client._id), accountCode: client.accountCode };
}

function startApp(testMongoUri) {
    const env = {
        ...process.env,
        NODE_ENV: 'development',
        PORT: String(port),
        MONGO_URI: testMongoUri,
        SESSION_STORE: 'memory',
        SESSION_SECRET: 'deposit-e2e-session-secret-change-me-123456',
        BYPASS_OTP: 'true',
        BYPASS_CLIENT_OTP: 'true',
        MASTER_OTP: '200104',
        SECURE_COOKIE: 'false'
    };

    const child = spawn(process.execPath, ['app.js'], {
        cwd: repoRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    const logFile = path.join(runDir, 'server.log');
    const logStream = fs.createWriteStream(logFile);
    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    return child;
}

async function verifyDatabase(testMongoUri, clientId) {
    await mongoose.connect(testMongoUri, { serverSelectionTimeoutMS: 30000, retryWrites: false });
    const User = require('../models/User');
    const Transaction = require('../models/Transaction');
    const Ledger = require('../models/Ledger');
    const Notification = require('../models/Notification');
    const { proofFilePath } = require('../services/proofStorageService');

    const client = await User.findById(clientId).lean();
    const tx = await Transaction.findOne({ userId: client.phone, status: 'deposit' }).sort({ createdAt: -1 }).lean();
    const ledger = tx ? await Ledger.findOne({ transactionId: tx.customId, entityModel: 'User' }).lean() : null;
    const notification = await Notification.findOne({ userId: client.phone, type: 'deposit' }).sort({ createdAt: -1 }).lean();
    const proofPath = tx && tx.proofImage ? proofFilePath(tx.proofImage) : null;

    await mongoose.disconnect();

    return {
        balance: client ? Number(client.balance || 0) : null,
        txId: tx ? tx.customId : null,
        txAmount: tx ? Number(tx.amount || 0) : null,
        proofImage: tx ? tx.proofImage : null,
        proofExists: Boolean(proofPath && fs.existsSync(proofPath)),
        ledgerBalanceAfter: ledger ? Number(ledger.balanceAfter || 0) : null,
        notificationTitle: notification ? notification.title : null
    };
}

async function runBrowserFlow(baseUrl, clientId) {
    const puppeteer = await loadPuppeteer();
    let bundledExecutablePath = null;
    try {
        bundledExecutablePath = await puppeteer.executablePath();
    } catch (_) {}
    const browserCandidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        bundledExecutablePath,
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    ].filter(Boolean);
    const executablePath = browserCandidates.find((candidate) => fs.existsSync(candidate));
    if (!executablePath) throw new Error('No local Chrome or Edge executable was found for screenshots.');

    const browser = await puppeteer.launch({
        headless: true,
        executablePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 });

    await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle2' });
    await page.type('#usernameInput', adminUsername);
    await page.type('#passwordInput', adminPassword);
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click('#submitBtn')
    ]);

    await page.goto(`${baseUrl}/user/${clientId}`, { waitUntil: 'networkidle2' });
    await page.screenshot({ path: path.join(screenshotsDir, '01-before-deposit-admin-client.png'), fullPage: true });

    await page.type('form[action$="/add-balance"] input[name="amount"]', String(depositAmount));
    await page.type('form[action$="/add-balance"] input[name="notes"]', 'E2E deposit receipt verification');
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click('form[action$="/add-balance"] button[type="submit"]')
    ]);

    if (page.url().includes('balanceError=')) {
        throw new Error(`Deposit form redirected with an error: ${page.url()}`);
    }

    await page.screenshot({ path: path.join(screenshotsDir, '02-after-deposit-admin-client.png'), fullPage: true });

    await page.goto(`${baseUrl}/logout`, { waitUntil: 'networkidle2' }).catch(() => {});
    await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle2' });
    await page.type('#usernameInput', clientUsername);
    await page.type('#passwordInput', clientPassword);
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click('#submitBtn')
    ]);

    try {
        await page.waitForFunction(
            (amount) => document.body.innerText.includes(amount.toFixed(2)) || document.body.innerText.includes('DEP-'),
            { timeout: 20000 },
            depositAmount
        );
    } catch (error) {
        await page.screenshot({ path: path.join(screenshotsDir, 'debug-client-login-failed.png'), fullPage: true });
        throw error;
    }
    await page.screenshot({ path: path.join(screenshotsDir, '03-client-dashboard-deposit-visible.png'), fullPage: true });

    const receiptLink = await page.$('.tx-id, .tx-custom-id');
    if (!receiptLink) throw new Error('Receipt link was not visible on the client dashboard.');
    await receiptLink.click();
    await page.waitForSelector('#proofContainer img', { timeout: 15000 });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await page.screenshot({ path: path.join(screenshotsDir, '04-deposit-receipt-modal.png'), fullPage: true });

    await browser.close();
}

async function main() {
    ensureDir(screenshotsDir);
    const dbName = `vodafone_cash_deposit_e2e_${Date.now()}`;
    const testMongoUri = buildTestMongoUri(process.env.MONGO_URI, dbName);
    const baseUrl = `http://127.0.0.1:${port}`;

    let child;
    let seed;
    let verification;
    try {
        seed = await seedDatabase(testMongoUri);
        child = startApp(testMongoUri);
        await waitForHealth(baseUrl);
        await runBrowserFlow(baseUrl, seed.clientId);
        verification = await verifyDatabase(testMongoUri, seed.clientId);

        const report = {
            ok: verification.balance === depositAmount
                && verification.txAmount === depositAmount
                && verification.proofExists
                && verification.ledgerBalanceAfter === depositAmount
                && Boolean(verification.notificationTitle),
            baseUrl,
            dbName,
            adminUsername,
            clientUsername,
            clientId: seed.clientId,
            depositAmount,
            verification,
            screenshots: fs.readdirSync(screenshotsDir).map((file) => path.join(screenshotsDir, file))
        };

        fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2));
        nodeSummary(report);
        if (!report.ok) process.exitCode = 1;
    } finally {
        if (child) child.kill();
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}

function nodeSummary(report) {
    console.log(JSON.stringify({
        ok: report.ok,
        runDir,
        depositAmount: report.depositAmount,
        balance: report.verification.balance,
        txId: report.verification.txId,
        proofImage: report.verification.proofImage,
        proofExists: report.verification.proofExists,
        ledgerBalanceAfter: report.verification.ledgerBalanceAfter,
        notificationTitle: report.verification.notificationTitle,
        screenshots: report.screenshots
    }, null, 2));
}

main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
});
