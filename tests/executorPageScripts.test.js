'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ejs = require('ejs');
const { portalAssets } = require('./helpers/executorPortalSources');
const root = path.join(__dirname,'..');
test.each(['settings','support','deposits'])('%s keeps its static behavior in a dedicated, parseable script', page => {
    const template = fs.readFileSync(path.join(root,'views/executor',page+'.ejs'),'utf8');
    const asset = `public/js/executor/${page}/page.js`;
    expect(portalAssets(template)).toContain(asset);
    const source = fs.readFileSync(path.join(root,asset),'utf8');
    expect(source).not.toContain('<%');
    expect(()=>new vm.Script(source)).not.toThrow();
    const inline = [...template.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    expect(inline.every(block => block[1].length < 1000)).toBe(true);
});
test('support bootstrap cannot terminate its script with an employee name', async () => {
    const attack = '</script><img src=x onerror=alert(1)>';
    const html = await ejs.renderFile(path.join(root,'views/executor/support.ejs'),{
        emp:{_id:'employee',name:attack,role:'manager',groupId:{name:'Test',balance:0}},
        companyBalances:null,csrfToken:'test',showMfaNotice:false
    });
    const bootstrap = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(block=>block[1].includes('executorSupportConfig'))[1];
    expect(bootstrap).not.toContain('</script>');
    const context={window:{}};
    vm.runInNewContext(bootstrap,context);
    expect(context.window.executorSupportConfig.currentEmployeeName).toBe(attack);
});
