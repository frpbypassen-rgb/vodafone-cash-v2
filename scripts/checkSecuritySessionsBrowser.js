'use strict';
const assert=require('node:assert/strict');
const express=require('express');
const path=require('node:path');
const {loadPuppeteer}=require('../utils/puppeteerLoader');
async function main(){
    const app=express();app.use(express.json());app.set('view engine','ejs');app.set('views',path.join(__dirname,'../views'));
    let devices=[],requests=[],mode='ok',posts=0,confirm=true,heldResponse,holdReached;
    const reset=()=>{devices=[{id:'other',displayName:'هاتف آخر',channel:'app',browser:'Firefox',platform:'Android',lastSeenAt:new Date(),lastIp:'127.0.0.2',current:false},{id:'current',displayName:'هذا الجهاز',channel:'web',browser:'Chrome',platform:'Windows',lastSeenAt:new Date(),lastIp:'127.0.0.1',current:true}];requests=[{id:'pending',displayName:'طلب تجريبي',channel:'app',requestCode:'TEST-001',expiresAt:new Date(Date.now()+60000)}];mode='ok';};
    app.get('/security/sessions',(_req,res)=>res.render('account_security_sessions',{csrfToken:'test-csrf',principalName:'حساب تجريبي',returnUrl:'/agent-portal/security',returnLabel:'أمان الحساب',isAgentSessions:true}));
    app.get('/security/sessions/data',(_req,res)=>{
        if(mode==='malformed')return res.type('text/html').send('<html>login required</html>');
        if(mode==='error')return res.status(500).json({success:false,error:'تعذر تحميل بيانات الاختبار.'});
        if(mode==='hold'){mode='ok';heldResponse=()=>res.json({success:true,devices:[...devices],requests:[...requests]});const old=JSON.stringify({success:true,devices,requests});heldResponse=()=>res.type('application/json').send(old);holdReached();return;}
        return res.json({success:true,devices,requests});
    });
    app.post('/security/sessions/revoke-others',(req,res)=>{assert.equal(req.headers['x-csrf-token'],'test-csrf');posts++;devices=devices.filter(device=>device.current);res.json({success:true,revokedCount:1});});
    app.post('/security/sessions/:id/revoke',(req,res)=>{assert.equal(req.headers['x-csrf-token'],'test-csrf');posts++;const current=req.params.id==='current';devices=devices.filter(device=>device.id!==req.params.id);res.json({success:true,currentRevoked:current});});
    app.post('/security/session-requests/:id/:decision',(req,res)=>{assert.equal(req.headers['x-csrf-token'],'test-csrf');posts++;if(req.params.decision==='approve'&&mode==='approval-denied')return res.status(400).json({success:false,error:'هذا الطلب يحتاج موافقة الإدارة حفاظاً على أمان الحساب.'});requests=[];res.json({success:true,channel:'app'});});
    app.get('/logout',(_req,res)=>res.send('Isolated test logout'));
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));let browser;
    try{
        browser=await(await loadPuppeteer()).launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH});
        const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>confirm?dialog.accept():dialog.dismiss());
        const origin=`http://127.0.0.1:${server.address().port}`;
        const click=selector=>page.$eval(selector,element=>element.click());
        const count=expected=>page.waitForFunction(value=>document.querySelector('[data-session-count]').textContent===String(value),{},expected);
        for(const width of [320,390,430,1440]){
            reset();await page.setViewport({width,height:844});await page.goto(origin+'/security/sessions?width='+width,{waitUntil:'networkidle2'});await count(2);
            assert.ok(await page.$('.compact-device:first-child.is-current'));
            await click('.compact-device:first-child > summary');assert.equal(await page.$eval('.compact-device:first-child',element=>element.open),true);
            assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
            await click('.sessions-requests-drawer > summary');mode='approval-denied';await click('[data-decision="approve"]');await page.waitForFunction(()=>document.querySelector('[data-status]').textContent.includes('موافقة الإدارة'));
            mode='ok';await click('[data-decision="reject"]');await page.waitForFunction(()=>document.querySelector('[data-request-count]').textContent==='0');
            const before=posts;confirm=false;await click('[data-revoke-others]');assert.equal(posts,before);confirm=true;
            const held=new Promise(resolve=>{holdReached=resolve;});mode='hold';await click('[data-refresh]');await held;
            await click('[data-revoke-others]');await count(1);assert.equal(await page.$eval('[data-revoke-others]',element=>element.hidden),true);
            heldResponse();await page.waitForNetworkIdle({idleTime:100});assert.equal(await page.$eval('[data-session-count]',element=>element.textContent),'1');
            assert.ok(await page.$eval('[data-status]',element=>element.textContent.includes('جلستك الحالية مستمرة')));
            mode='malformed';await click('[data-refresh]');await page.waitForFunction(()=>document.querySelector('[data-status]').classList.contains('error'));assert.equal(await page.$eval('[data-session-count]',element=>element.textContent),'—');
            mode='ok';await click('[data-refresh]');await count(1);
            devices=[];await click('[data-refresh]');await count(0);assert.ok(await page.$eval('[data-devices]',element=>element.textContent.includes('لا توجد جلسات')));
        }
        reset();await page.goto(origin+'/security/sessions?single',{waitUntil:'networkidle2'});await count(2);
        await page.$eval('.compact-device:not(.is-current)',element=>{element.open=true;});await click('[data-revoke="other"]');await count(1);
        await page.$eval('.compact-device.is-current',element=>{element.open=true;});await Promise.all([page.waitForNavigation(),click('[data-revoke="current"]')]);assert.equal(new URL(page.url()).pathname,'/logout');
        assert.deepEqual(errors,[]);
        console.log(JSON.stringify({result:'PASS',checks:['4 screen sizes','current first','session details','single/current logout','bulk keeps current','confirmation cancellation','request rejection','admin approval denial','stale response ignored','malformed response rejected','refresh recovery','empty state','CSRF','no JS errors']}));
    }finally{if(browser)await browser.close();if(heldResponse)heldResponse=undefined;await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
