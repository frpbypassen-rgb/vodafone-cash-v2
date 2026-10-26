'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadPuppeteer } = require('../utils/puppeteerLoader');
const base = process.env.COMPANY_DEMO_URL || 'http://127.0.0.1:4577';

// A separate test HTTP session verifies attachments without exporting browser credentials.
async function downloadReport(url) {
    const jar=new Map();
    const remember=response=>response.headers.getSetCookie().forEach(value=>{const pair=value.split(';')[0];jar.set(pair.slice(0,pair.indexOf('=')),pair);});
    const cookie=()=>[...jar.values()].join('; ');
    const login=await fetch(base+'/login?portal=client');remember(login);
    const html=await login.text();
    const csrf=html.match(/name="_csrf" value="([^"]+)"/)[1];
    const result=await fetch(base+'/login',{method:'POST',redirect:'manual',headers:{Cookie:cookie(),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({_csrf:csrf,username:'company_demo@ahram.com',password:process.env.COMPANY_DEMO_PASSWORD,portal:'client'})});
    remember(result);assert.equal(result.status,302);assert(!String(result.headers.get('location')).includes('login'));
    const response=await fetch(url,{headers:{Cookie:cookie()}});assert.equal(response.status,200);
    assert(response.headers.get('content-type').includes('application/pdf'));
    return Buffer.from(await response.arrayBuffer());
}

async function main() {
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base)) throw new Error('Only a local demo is supported.');
    if (!process.env.COMPANY_DEMO_PASSWORD) throw new Error('COMPANY_DEMO_PASSWORD is required.');
    const output = path.resolve(process.argv[2] || 'outputs/company-mobile-browser');
    fs.mkdirSync(output, { recursive: true });
    const browser = await (await loadPuppeteer()).launch({ headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH });
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.setViewport({ width: 390, height: 844, isMobile: true });
        await page.setRequestInterception(true);
        page.on('request', request => {
            if (request.url().startsWith(base) || request.url().startsWith('data:')) return request.continue();
            // Do not contact external delivery services during local checks.
            return request.abort();
        });
        await page.goto(`${base}/login?portal=client`, { waitUntil: 'domcontentloaded' });
        await page.type('#usernameInput', 'company_demo@ahram.com');
        await page.type('#passwordInput', process.env.COMPANY_DEMO_PASSWORD);
        await Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.$eval('#loginForm', form => form.requestSubmit())]);
        await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
        if(await page.$eval('#companyWelcomeDialog',el=>el.open)) await page.locator('#companyWelcomeDialog [data-dialog-close]').click();
        assert(!page.url().includes('/login'), 'The real company login must succeed');
        const routes = ['/client/dashboard?home=1','/client/services',...['cash','bank','post-account','post-card','sefa','bankak'].map(service=>'/client/services/'+service),'/client/smart-transfer','/client/internal-transfer','/client/company/deposits','/client/transactions','/client/staff','/client/finance','/client/reports?scope=organization&period=today','/client/reports?scope=staff','/client/settings',...['identity','preferences','notifications','integrations','services'].map(panel=>'/client/settings#'+panel),'/client/security','/client/security#companyPassword','/client/security#companyMfa','/security/sessions','/client/support'];
        const widths=process.argv.includes('--pdf-only')?[]:[320,360,390,430,1280];
        for (const width of widths) {
            await page.setViewport({ width, height: width === 1280 ? 900 : 844, isMobile: width < 600 });
            for (const route of routes) {
                const response = await page.goto(base + route, { waitUntil: 'domcontentloaded' });
                if(response) assert.equal(response.status(), 200, route);
                if(!route.startsWith('/security/')) await page.waitForFunction(() => document.body.dataset.workspaceReady === 'true');
                await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
                assert(!page.url().includes('/login'), `Session lost on ${route}`);
                const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
                assert.equal(overflow, false, `${width}px overflow: ${route}`);
                if(route.includes('/settings#')) {
                    const panel=route.split('#')[1];
                    assert(await page.$eval('#'+panel,el=>!el.hidden),`Settings panel ${panel} must be reachable`);
                }
                if (route.includes('/services/')) {
                    assert(await page.$('.agent-cash-balance'), 'A visible-balance role gets the service balance');
                    assert.equal(await page.$$eval('#businessTransferForm', forms => forms.length), 1);
                }
                if (width === 390) await page.screenshot({ path: path.join(output, route.replace(/[^a-z0-9]/gi, '_')+'.png'), fullPage: true });
            }
        }
        await page.setViewport({ width: 390, height: 844, isMobile: true });
        await page.goto(base+'/client/staff', { waitUntil: 'domcontentloaded' });
        assert(await page.$$eval('[data-staff-row]', rows => rows.length >= 6));
        await page.type('[data-staff-search]', 'سارة');
        assert.equal(await page.$$eval('[data-staff-row]', rows => rows.filter(row => !row.hidden).length), 1);
        await page.$eval('[data-dialog-open="createStaffDialog"]', button => button.click());
        assert(await page.$eval('#createStaffDialog', dialog => dialog.open));
        assert(await page.$('[name="permission_canCreateTransfer"]'));
        await page.screenshot({ path: path.join(output,'create-staff.png'), fullPage: true });
        await page.$eval('#createStaffDialog [data-dialog-close]', button => button.click());
        await page.$eval('#agentMoreButton', button => button.click());
        assert(await page.$eval('#agentMoreMenu', menu => menu.matches(':popover-open')));
        assert.equal(await page.$eval('.bw-sidebar', el => getComputedStyle(el).display).catch(() => 'none'), 'none');
        assert(await page.$('#agentMoreMenu a[href="/client/reports"]'));
        await page.screenshot({ path: path.join(output,'more-menu.png'), fullPage: true });
        await page.goto(base+'/client/reports?scope=organization&period=today', { waitUntil: 'domcontentloaded' });
        const pdfUrl=await page.$eval('.agent-report-official-download',link=>link.href);
        assert(pdfUrl.startsWith(base+'/client/reports/central.pdf'));
        const bytes=await downloadReport(pdfUrl);
        assert.equal(bytes.subarray(0,4).toString(),'%PDF');assert(bytes.length>1000);
        for(const [username,isAccountant] of [['company_staff1@ahram.com',false],['company_accountant@ahram.com',true]]) {
            const context=await browser.createBrowserContext();
            const rolePage=await context.newPage();
            await rolePage.goto(base+'/login?portal=client',{waitUntil:'domcontentloaded'});
            await rolePage.type('#usernameInput',username);
            await rolePage.type('#passwordInput',process.env.COMPANY_DEMO_PASSWORD);
            await Promise.all([rolePage.waitForNavigation({waitUntil:'domcontentloaded'}),rolePage.$eval('#loginForm',form=>form.requestSubmit())]);
            assert(!rolePage.url().includes('/login'));
            await rolePage.waitForFunction(()=>document.body.dataset.workspaceReady==='true');
            if(!isAccountant) {
                assert.equal(await rolePage.$('.agent-cash-balance'),null);
                const forbidden=await rolePage.evaluate(async()=>({email:(await fetch('/client/api/report-email')).status,telegram:(await fetch('/client/api/telegram')).status}));
                assert.deepEqual(forbidden,{email:403,telegram:403});
            } else {
                await rolePage.goto(base+'/client/finance',{waitUntil:'domcontentloaded'});
                assert(await rolePage.$('.agent-ledger'));
                await rolePage.goto(base+'/client/staff',{waitUntil:'domcontentloaded'});
                assert.equal(await rolePage.$('#createStaffDialog'),null);
                assert.equal(await rolePage.$('[data-permission-edit-form]'),null);
            }
            await context.close();
        }
        assert.deepEqual(errors, []);
        console.log(JSON.stringify({ passed: true, checkedRoutes: widths.length?routes.length:0, widths, realLogin: true, staffSearch: true, createDialog: true, moreMenu: true, officialPdf:true,employeePrivacy:true,accountantRestrictions:true }));
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
