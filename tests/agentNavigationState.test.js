'use strict';
const {cleanQuery, install}=require('../public/js/agent-portal/list-state');
const {renderAgentPage}=require('./helpers/agentPortalFixtures');
const makeStorage=()=>{const data={};return new Proxy({getItem:key=>data[key]??null,setItem:(key,value)=>{data[key]=value;},removeItem:key=>{delete data[key];}}, {ownKeys:()=>Object.keys(data),getOwnPropertyDescriptor:()=>({enumerable:true,configurable:true})});};
const field=value=>({value,tagName:'INPUT',type:'search',listeners:{},addEventListener(name,fn){this.listeners[name]=fn;}});
const link=href=>({getAttribute:()=>href,setAttribute:(_key,value)=>{href=value;}});
const environment=(storage,scope,path,search='',fields={},links=[])=>{
 const listeners={};
 const document={documentElement:{dataset:{portal:'agent'}},querySelector:selector=>fields[selector]||null,querySelectorAll:selector=>selector.startsWith('form[')?[]:links,addEventListener:(name,fn)=>{listeners[name]=fn;}};
 return {sessionStorage:storage,agentPortal:{notificationScope:scope},document,location:{pathname:path,search},addEventListener:(name,fn)=>{listeners[name]=fn;},listeners};
};

test('only list query fields survive; tokens and transfer instructions are excluded',()=>{
 expect(cleanQuery('?search=Ahmed&status=pending&token=secret&amount=100&target_number=123')).toBe('search=Ahmed&status=pending');
});
test('client-side search restores only inside the same account, page and query',()=>{
 const storage=makeStorage(),input=field('');
 install(environment(storage,'owner-a:staff-a','/agent-portal/customers','',{'[data-customer-search]':input}));
 input.value='عميل الاختبار';input.listeners.input();
 const restored=field('');install(environment(storage,'owner-a:staff-a','/agent-portal/customers','',{'[data-customer-search]':restored}));
 expect(restored.value).toBe('عميل الاختبار');
 const foreign=field('');install(environment(storage,'owner-a:staff-b','/agent-portal/customers','',{'[data-customer-search]':foreign}));expect(foreign.value).toBe('');
 const explicit=field('');install(environment(storage,'owner-a:staff-a','/agent-portal/customers','?status=inactive',{'[data-customer-search]':explicit}));expect(explicit.value).toBe('');
});
test('navigation returns to saved server filters while explicit links remain unchanged',()=>{
 const storage=makeStorage();install(environment(storage,'a','/agent-portal/reports','?scope=staff&period=today'));
 const bare=link('/agent-portal/reports'),explicit=link('/agent-portal/reports?scope=customers');
 install(environment(storage,'a','/agent-portal/settings','',{},[bare,explicit]));
 expect(bare.getAttribute()).toBe('/agent-portal/reports?period=today&scope=staff');
 expect(explicit.getAttribute()).toBe('/agent-portal/reports?scope=customers');
});
test('logout clears only this actor state and blocked storage is harmless',()=>{
 const storage=makeStorage();install(environment(storage,'other','/agent-portal/reports','?scope=staff'));
 const win=environment(storage,'current','/agent-portal/customers');install(win);
 win.listeners.click({target:{closest:()=>link('/agent-portal/logout')}});
 expect(storage.getItem('agent-list-state:v1:current:/agent-portal/customers')).toBeNull();
 expect(storage.getItem('agent-list-state:v1:other:/agent-portal/reports')).not.toBeNull();
 const blocked=environment(storage,'current','/agent-portal/customers');Object.defineProperty(blocked,'sessionStorage',{get(){throw Error('blocked');}});
 expect(()=>install(blocked)).not.toThrow();
});
test('owner navigation exposes settings directly and the desktop menu contains every permitted section',async()=>{
 const html=await renderAgentPage('overview','owner');
 expect(html).toContain('id="agentDesktopMoreButton" popovertarget="agentMoreMenu"');
 expect(html).toContain('class="bw-button ghost agent-header-settings" href="/agent-portal/settings"');
 const menu=html.slice(html.indexOf('<nav id="agentMoreMenu"'),html.indexOf('</nav>',html.indexOf('<nav id="agentMoreMenu"')));
 for(const route of ['dashboard','services','transactions','finance','finance/profits','customers','staff','reports','settings','support'])expect(menu).toContain('/agent-portal/'+route);
 const index=html.indexOf('/js/agent-portal/list-state.js');expect(index).toBeGreaterThan(0);expect(index).toBeLessThan(html.indexOf('/js/agent-portal/customers.js')<0?html.length:html.indexOf('/js/agent-portal/customers.js'));
});
