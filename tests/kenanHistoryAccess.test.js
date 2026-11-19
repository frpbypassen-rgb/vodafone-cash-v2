'use strict';
const express = require('express');
const request = require('supertest');
const path = require('node:path');

jest.mock('axios', () => ({ get:jest.fn() }));
const axios = require('axios');
const Group = require('../models/ExecutorGroup');
const router = require('../routes/executors');
const owner = '614ef2321234123412345678', other = '614ef2321234123412345679', botId = '614ef232123412341234567a';

function historyPage(session, tenantId) {
    const app = express();
    app.set('view engine','ejs').set('views',path.join(__dirname,'../views'));
    app.use((req,res,next) => { req.session=session; req.tenantId=tenantId; next(); });
    app.use(router);
    return request(app).get('/executor/'+botId+'/kenan-history').set('Accept','application/json');
}

const oldMode = process.env.TENANT_MODE, oldExternal = process.env.EXTERNAL_API_ENABLED;
const admin = {isLoggedIn:true,adminPermissions:['executors.read']};
beforeEach(() => {
    process.env.TENANT_MODE='multi';
    process.env.EXTERNAL_API_ENABLED='true';
    axios.get.mockReset().mockImplementation(async url => ({data:url.endsWith('/communications')
        ? [{method:'POST',path:'/api/company/orders',http_status:202,reference:'0000014',response:'raw-secret-and-body'}] : []}));
    jest.spyOn(Group,'findOne').mockImplementation(query => ({select:()=>({lean:async()=>query.tenantId===owner
        && query._id===botId && query.isApiBot===true && query.apiProviderKey==='kenan'
        ? {_id:botId,name:'Kenan',apiToken:'private-fixture-token',apiUrl:'https://kenan.example'} : null})}));
});
afterEach(() => {
    jest.restoreAllMocks();
    for (const [k,value] of Object.entries({TENANT_MODE:oldMode,EXTERNAL_API_ENABLED:oldExternal})) {
        if (value===undefined) delete process.env[k]; else process.env[k]=value;
    }
});

test('the authenticated scoped reader sees allowlisted account communications', async () => {
    const page = await historyPage(admin,owner).expect(200);
    expect(page.headers['cache-control']).toContain('no-store');
    expect(axios.get).toHaveBeenCalledTimes(3);
    expect(page.text).toContain('سجل التخاطب لدى كنان');
    expect(page.text).toContain('0000014');
    expect(page.text).not.toContain('private-fixture-token');
    expect(page.text).not.toContain('raw-secret-and-body');
});

test.each([[{},owner,401],[{isLoggedIn:true,adminPermissions:[]},owner,403],[admin,other,404],[admin,undefined,404]])(
    'unavailable account or insufficient permissions deny access before any provider read', async (session,tenant,status) => {
        await historyPage(session,tenant).expect(status);
        expect(axios.get).not.toHaveBeenCalled();
    });
