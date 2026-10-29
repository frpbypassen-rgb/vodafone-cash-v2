'use strict';
const path=require('node:path'), fs=require('node:fs'),vm=require('node:vm');
const express=require('express'),request=require('supertest'),ejs=require('ejs');
const present=require('../utils/loginPagePresentation');
const assetHeaders=require('../utils/loginAssetHeaders');
const now=Date.now();
const session={pendingAccountMfaLogin:{accountId:'fixture',createdAt:now},pendingSecurityLocation:{latitude:0,longitude:0,accuracy:15}};

test('MFA presentation reuses location only within the password challenge lifetime',()=>{
    expect(present({session},{accountMfaChallenge:true},now)).toMatchObject({view:'client/authenticator_verify',location:{latitude:0,longitude:0}});
    expect(present({session},{},now)).toEqual({view:'unified_login',location:null});
    expect(present({session},{accountMfaChallenge:true},now+300001).location).toBeNull();
    expect(present({session:{...session,pendingSecurityLocation:{latitude:999,longitude:0}}},{accountMfaChallenge:true},now).location).toBeNull();
    expect(present({session:{pendingSecurityLocation:session.pendingSecurityLocation}},{accountMfaChallenge:true},now).location).toBeNull();
});

test('actual login renderer disables compiled view caching and emits no-store for both steps',()=>{
    const source=fs.readFileSync(path.join(__dirname,'../routes/auth.js'),'utf8');
    const start=source.indexOf('const renderLogin = '),end=source.indexOf('const EXECUTOR_MFA_CHALLENGE_TTL_MS',start);
    const context={require:()=>present,SECURITY_LOGIN_ERRORS:{},isPasswordResetEmailEnabled:()=>false,
        getBrandContact:()=>({}),isSecurityVerificationRequired:()=>true,getEmergencyClientOtpBypassState:()=>({active:false})};
    vm.runInNewContext(source.slice(start,end)+';this.renderLogin=renderLogin;',context);
    const res={req:{session,query:{},loginLocationRequired:true},set:jest.fn(),render:jest.fn()};
    context.renderLogin(res,null,{accountMfaChallenge:true});
    expect(res.set).toHaveBeenCalledWith('Cache-Control','private, no-store');
    expect(res.render).toHaveBeenLastCalledWith('client/authenticator_verify',expect.objectContaining({cache:false,mfaLocation:session.pendingSecurityLocation}));
    context.renderLogin(res);
    expect(res.render).toHaveBeenLastCalledWith('unified_login',expect.objectContaining({cache:false,mfaLocation:null}));
});

test('auth assets are not cached while unrelated asset caching remains enabled',async()=>{
    const app=express();app.use(express.static(path.join(__dirname,'../public'),{maxAge:'1h',setHeaders:assetHeaders}));
    await request(app).get('/js/login-location.js?v=20261027-policy').expect('Cache-Control','no-store').expect(200);
    await request(app).get('/js/authenticator-login.js').expect('Cache-Control','no-store').expect(200);
    const normal={setHeader:jest.fn()};assetHeaders(normal,'/public/css/other.css');expect(normal.setHeader).not.toHaveBeenCalled();
});

test('new Authenticator page preserves the login contract, escapes errors and prefills proven coordinates',async()=>{
    const html=await ejs.renderFile(path.join(__dirname,'../views/client/authenticator_verify.ejs'),{
        csrfToken:'fixture-csrf',adminPortal:false,clientPortal:true,error:'<script>bad()</script>',locationRequired:true,mfaLocation:session.pendingSecurityLocation
    });
    expect(html).toContain('name="mfaToken"');expect(html).toContain('action="/login"');
    expect(html).toContain('name="latitude" id="latitudeInput" value="0"');
    expect(html).toContain('value="fixture-csrf"');expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>bad()');expect(html).not.toContain('auth-control-room-gauge');
    expect(html).not.toContain('data-otp-methods');
});
