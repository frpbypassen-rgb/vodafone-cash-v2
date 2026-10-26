'use strict';
const assert=require('node:assert/strict');
const {loadPuppeteer}=require('../utils/puppeteerLoader');
async function main(){
    const base='http://127.0.0.1:4577';
    if(!process.env.COMPANY_DEMO_PASSWORD) throw new Error('COMPANY_DEMO_PASSWORD is required');
    const browser=await(await loadPuppeteer()).launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH});
    try{
        const page=await browser.newPage();const errors=[];
        page.on('pageerror',error=>errors.push(error.message));
        await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
        await page.setRequestInterception(true);
        page.on('request',req=>req.url().startsWith(base)||req.url().startsWith('data:')?req.continue():req.abort());
        const open=async route=>{await page.goto(base+route,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>document.body.dataset.workspaceReady==='true');};
        await page.goto(base+'/login?portal=client',{waitUntil:'domcontentloaded'});
        await page.type('#usernameInput','company_demo@ahram.com');await page.type('#passwordInput',process.env.COMPANY_DEMO_PASSWORD);
        await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),page.locator('#submitBtn').click()]);
        await page.waitForFunction(()=>document.body.dataset.workspaceReady==='true');
        if(await page.$eval('#companyWelcomeDialog',el=>el.open)) await page.locator('#companyWelcomeDialog [data-dialog-close]').click();
        await page.tap('#agentMoreButton');
        await page.waitForSelector('#agentMoreMenu:popover-open');
        await page.keyboard.press('Escape');
        await page.waitForFunction(()=>!document.getElementById('agentMoreMenu').matches(':popover-open'));
        await open('/client/settings');
        await page.locator('.cm-settings-categories a[href="#services"]').click();
        await page.waitForFunction(()=>!document.getElementById('services').hidden);
        await page.locator('[data-settings-back]').click();
        await page.waitForFunction(()=>!document.querySelector('.cm-settings-categories').hidden);
        await open('/client/staff');
        await page.locator('[data-dialog-open="createStaffDialog"]').click();
        await page.locator('#createStaffDialog [data-create-submit]').click();
        await page.waitForSelector('#createStaffDialog [aria-invalid="true"]');
        await page.type('#createStaffDialog [name="name"]','موظف مراجعة');
        await page.type('#createStaffDialog [name="phone"]','0910000110');
        await page.type('#createStaffDialog [name="webUsername"]','company_demo');
        await page.type('#createStaffDialog [name="webPassword"]',process.env.COMPANY_DEMO_PASSWORD);
        const [duplicate]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/company/staff/add')),page.locator('#createStaffDialog [data-create-submit]').click()]);
        assert.equal(duplicate.status(),400);
        await page.waitForFunction(()=>document.querySelector('#createStaffDialog [name="webUsername"]').getAttribute('aria-invalid')==='true');
        assert.equal(await page.$eval('#createStaffDialog [name="name"]',el=>el.value),'موظف مراجعة');
        assert.equal(await page.$eval('#createStaffDialog [data-create-submit]',el=>el.disabled),false);
        await page.locator('#createStaffDialog [data-dialog-close]').click();
        await page.locator('[data-staff-row] summary').click();
        assert(await page.$eval('[data-staff-row]',el=>el.open));
        const child=await page.$('[data-staff-row] [data-permission-edit-form]');
        if(child){
            const dialogId=await child.evaluate(form=>form.closest('dialog').id);
            const row=await child.evaluateHandle(form=>form.closest('[data-staff-row]'));
            if(!await row.evaluate(el=>el.open)) await(await row.$(':scope > summary')).click();
            await page.locator(`[data-dialog-open="${dialogId}"]`).click();
            assert(await page.$eval('#'+dialogId,el=>el.open));
            await page.keyboard.press('Escape');
        }
        await open('/client/services/cash');
        await page.type('#transferDestination','01000000000');await page.type('#transferAmount','100');
        await page.locator('#transferSubmitButton').click();
        await page.waitForSelector('#transferConfirmDialog[open]');
        await page.keyboard.press('Escape');
        assert.equal(await page.$eval('#transferConfirmDialog',el=>el.open),false);
        assert.deepEqual(errors,[]);
        console.log(JSON.stringify({passed:true,touchMore:true,escapeClose:true,settingsBack:true,emptyValidation:true,duplicatePreservesInput:true,transferReviewOnly:true}));
    }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
