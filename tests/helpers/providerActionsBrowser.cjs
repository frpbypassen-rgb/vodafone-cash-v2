'use strict';

// Usage: node tests/helpers/providerActionsBrowser.cjs /path/to/sweetalert2@11.js
// Tests complete admin pages with their own scripts. All payment/status/observation APIs are local fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {once} = require('node:events');
const ejs = require('ejs');
const express = require('express');
const {providerCommunicationView} = require('../../utils/providerCommunicationView');

async function main() {
    const {default:puppeteer} = await import('puppeteer');
    const swal = fs.readFileSync(process.argv[2]);
    const root = path.resolve(__dirname, '../..');
    const id = '507f1f77bcf86cd799439011';
    const tx = {_id:id,customId:'TEST-ZAYN',createdAt:new Date(),updatedAt:new Date(),status:'processing',
        amount:10,transferType:'vodafone',providerReviewAvailable:true,notes:'',
        apiResultData:{providerTransactionId:'TEST-REF',zaynPaymentReplyState:'pending',zaynPaymentReplyAt:new Date()}};
    const base = {adminName:'Fixture',role:'master',csrfToken:'fixture',query:{},providerCommunicationView,transactions:[tx]};
    const app = express();
    app.use(express.json());
    const posts = [], reads = [], output = [];
    app.get('/transactions/operations', async (req,res) => {
        if (req.query.fragment) return res.status(204).end();
        res.send(await ejs.renderFile(path.join(root,'views','transactions.ejs'),{...base,
            allBotsMap:{},allGroupsMap:{},executorBots:[],executorGroups:[],executorDisplayByTransaction:{},
            operationWorkspace:true,currentPage:1,totalPages:1,totalTxs:1,search:'',statusFilter:'',
            fromDate:'',toDate:'',filterType:'',executorId:'',dailyTotals:{},periodStats:{},
            activeClientCompanies:[],fundedExecutorCompanies:[],executorBalanceGroups:[]}));
    });
    app.get('/executor/e1',async (_req,res) => res.send(await ejs.renderFile(path.join(root,'views','api_room.ejs'),
        {...base,bot:{_id:'e1',name:'Fixture',apiProviderKey:'zayn_external_aggregator'},isMaster:true,
            managerBots:[],balanceAudits:[],providerReturns:[],stats:{successCount:0,failedCount:0,balanceAlertCount:0,providerReturnCount:0}})));
    app.get(['/transactions/:id/provider-communication','/executor/e1/transactions/:id/provider-communication'],(req,res)=>{
        reads.push(req.path);
        res.json({...providerCommunicationView(tx),text:'Fixture matched receipt',refresh:false});
    });
    app.post('/transaction/:id/provider-status-check',(req,res)=>{
        posts.push({path:req.path,csrf:req.get('x-csrf-token')});
        res.json({success:true,code:'PROVIDER_RETURNED',message:'Fixture cancelled receipt'});
    });
    app.use((req,res,next)=> {
        if(req.method==='POST') {posts.push({path:req.path});return res.sendStatus(409);}
        next();
    });
    app.use(express.static(path.join(root,'public')));
    const server=app.listen(0,'127.0.0.1');
    await once(server,'listening');
    let browser;
    try {
        const origin='http://127.0.0.1:'+server.address().port;
        browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH, args:['--no-sandbox']});
        const page=await browser.newPage();
        page.setDefaultTimeout(6000);
        const errors=[];
        page.on('pageerror',e=>errors.push(e.message));
        await page.setRequestInterception(true);
        page.on('request',req=>{
            if(req.url().startsWith(origin+'/') || req.url().startsWith('data:')) return void req.continue();
            if(req.url()==='https://cdn.jsdelivr.net/npm/sweetalert2@11') return void req.respond({contentType:'application/javascript',body:swal});
            return void req.respond({status:200,contentType:req.resourceType()==='stylesheet'?'text/css':'application/javascript',body:''});
        });
        await page.setViewport({width:1280,height:800});
        for(const entry of ['/transactions/operations','/executor/e1']) {
            await page.goto(origin+entry);
            const scripts=await page.$$eval('script[src]',els=>els.filter(s=>new URL(s.src).pathname==='/js/provider-communication.js').length);
            assert.deepEqual(errors, [], entry+' must not have page errors: '+errors.join(' | '));
            assert.equal(scripts,1,entry+' communication handler must be loaded exactly once');
            const open=()=>page.waitForSelector('.swal2-popup',{visible:true});
            const close=async selector=>{await page.click(selector);await page.waitForSelector('.swal2-popup',{hidden:true});};
            await page.click('[data-provider-communication]');
            await open();
            await page.waitForFunction(()=>document.querySelector('.swal2-html-container')?.textContent==='Fixture matched receipt');
            await close('.swal2-confirm');
            if(entry==='/transactions/operations'){
                await page.click('[data-provider-row-action="check"]');
                await open();
                assert.equal(await page.$eval('.swal2-html-container',el=>el.textContent),'Fixture cancelled receipt');
                await close('.swal2-confirm');
                for(const action of ['paid','cancel']) {
                    await page.click('[data-provider-row-action="'+action+'"]');
                    await open();
                    assert.ok(await page.$('#provider-row-evidence'));
                    await close('.swal2-cancel');
                }
            }
            assert.deepEqual(errors,[]);
            output.push({page:entry,standaloneScriptCount:scripts,modalOpened:true});
        }
        assert.deepEqual(posts,[{path:'/transaction/'+id+'/provider-status-check',csrf:'fixture'}]);
        assert.deepEqual(reads,['/transactions/'+id+'/provider-communication','/executor/e1/transactions/'+id+'/provider-communication']);
        console.log(JSON.stringify({browser:await browser.version(),pages:output,statusChecks:posts.length,reads:reads.length,financialRequests:0,externalNetworkRequests:0}));
    } finally {
        await browser?.close();
        server.closeAllConnections();
        await new Promise(resolve=>server.close(resolve));
    }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
