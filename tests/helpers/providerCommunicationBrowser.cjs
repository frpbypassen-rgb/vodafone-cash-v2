'use strict';

// Pass the SweetAlert2 JS served by the application's CDN as a local file.
// All browser traffic in this test stays on the local fixture origin.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const assert = require('node:assert/strict');
const ejs = require('ejs');
const {providerCommunicationView} = require('../../utils/providerCommunicationView');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const root = path.resolve(__dirname,'../..');

async function main() {
    const swal = fs.readFileSync(process.argv[2]);
    const script = fs.readFileSync(path.join(root,'public/js/provider-communication.js'));
    const {default:puppeteer} = await import('puppeteer');
    const at = new Date();
    const initial = providerCommunicationView({status:'processing',apiResultData:{providerDispatchStartedAt:at}});
    const result = (id,done) => ({...providerCommunicationView({status:done?'completed':'processing',
        apiResultData:{kenanReference:id,kenanProviderStatus:done?'success':'queued',kenanAwaitingStatus:!done}}), refresh:!done});
    const partial = path.join(root,'views/partials/provider_communication.ejs');
    const buttons = await Promise.all(['a','b'].map(id => ejs.renderFile(partial,{tx:{_id:id},communication:initial})));
    const html = '<html lang="ar" dir="rtl"><meta charset="UTF-8"><body>'+buttons.join('')+
        '<script src="/swal"></script><script src="/ui"></script></body></html>';
    let reads = [], hold, release, mode = 'normal';
    const server = http.createServer(async (req,res) => {
        if (req.url==='/') return res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'}).end(html);
        if (req.url==='/swal' || req.url==='/ui') return res.writeHead(200,{'Content-Type':'text/javascript'}).end(req.url==='/swal'?swal:script);
        if (req.url==='/favicon.ico') return res.writeHead(204).end();
        const id = req.url.match(/^\/transactions\/([ab])\/provider-communication$/)?.[1];
        if (!id) return res.writeHead(404).end();
        reads.push({id,method:req.method,time:Date.now()});
        const done = mode==='switch' || reads.filter(item => item.id===id).length>1;
        if (mode==='switch' && id==='a') await hold;
        res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(result(id==='a'?'0000014':'0000020',done)));
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    const origin = 'http://127.0.0.1:'+server.address().port;
    const browser = await puppeteer.launch({headless:true,pipe:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH || await puppeteer.executablePath()});
    const evidence = [];
    try {
        for (const width of [400,1280]) {
            reads = []; mode='normal';
            const page = await browser.newPage();
            let errors = [], external = [];
            page.on('pageerror',err => errors.push(err.message));
            page.on('request',r => { if (!r.url().startsWith(origin+'/')) external.push(new URL(r.url()).origin); });
            await page.setViewport({width,height:760});
            await page.goto(origin);
            const click = id => page.click('[data-observation-url="/transactions/'+id+'/provider-communication"]');
            const waitText = text => page.waitForFunction(t => window.Swal.getHtmlContainer()?.textContent?.includes(t), {timeout:10000},text);
            await click('a');
            await waitText('في طابور كنان');
            assert.equal(await page.$eval('[data-provider-communication]',el=>el.classList.contains('btn-success')),true);
            await waitText('نجحت لدى كنان');
            await pause(5150);
            assert.equal(reads.length,2);
            const pollIntervalMs = reads[1].time-reads[0].time;
            assert.ok(pollIntervalMs>=4900);
            await page.click('.swal2-confirm');
            await page.waitForFunction(()=>!window.Swal.getPopup());
            mode='switch'; hold=new Promise(resolve=>{release=resolve;});
            await click('a');
            for (let i=0;i<100 && reads.length<3;i++) await pause(25);
            assert.equal(reads.length,3);
            await page.evaluate(()=>document.querySelector('[data-observation-url*="/b/"]').click());
            await waitText('0000020');
            release(); await pause(250);
            assert.ok(!(await page.$eval('.swal2-html-container',el=>el.textContent)).includes('0000014'));
            await page.click('.swal2-confirm');
            await page.waitForFunction(()=>!window.Swal.getPopup());
            assert.deepEqual(reads.map(r=>r.method),['GET','GET','GET','GET']);
            assert.deepEqual(errors,[]); assert.deepEqual(external,[]);
            evidence.push({width,pollIntervalMs,localReads:reads.length,terminalStopped:true,staleResponseIsolated:true,
                pageErrors:errors.length,externalRequests:external.length});
            await page.close();
        }
        process.stdout.write(JSON.stringify({at:new Date().toISOString(),runtime:process.version,browser:await browser.version(),
            fixture:'Loopback, synthetic persisted observations, actual EJS, browser timer and modal library',evidence},null,2)+'\n');
    } finally {
        release?.();
        await browser.close();
        await new Promise(resolve=>server.close(resolve));
    }
}
main().catch(error=>{ console.error(error); process.exitCode=1; });
