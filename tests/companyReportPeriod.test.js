'use strict';
const { centralCompanyReportInput } = require('../services/portalWorkspace/reports');
const workspace={isCompany:true,entity:{_id:'company-only'}};
afterEach(()=>jest.useRealTimers());
test('uses Libya day at the UTC month boundary',()=>{
    jest.useFakeTimers().setSystemTime(new Date('2026-10-31T22:30:00Z'));
    expect(centralCompanyReportInput(workspace).dateValue).toBe('2026-11');
    expect(centralCompanyReportInput(workspace,{period:'today'}).dateValue).toBe('2026-11-01');
});
test.each([{from:'2026-10-30',to:'2026-10-01'},{month:'2026-13'},{from:'2026-02-30',to:'2026-03-01'}])('rejects invalid report period %j',query=>{
    expect(()=>centralCompanyReportInput(workspace,query)).toThrow('INVALID_REPORT_DATE');
});
test('company identity is independent of user-supplied report owner fields',()=>{
    expect(centralCompanyReportInput(workspace,{mainCategory:'agent',subId:'foreign',month:'2026-10'})).toMatchObject({mainCategory:'company',subId:'company-only',dateType:'month',dateValue:'2026-10'});
});
test('invalid report period does not sign the user out',async()=>{
    const portal=require('../services/businessPortalService');
    const load=jest.spyOn(portal,'loadPageContext').mockRejectedValueOnce(new Error('INVALID_REPORT_DATE'));
    const res={status:jest.fn().mockReturnThis(),send:jest.fn(),redirect:jest.fn()};
    try{
        await require('../controllers/portalWorkspace/queriesController').renderPage('reports')({session:{accountType:'company'}},res);
        expect(res.status).toHaveBeenCalledWith(400);expect(res.redirect).not.toHaveBeenCalled();
    }finally{load.mockRestore();}
});
test('the canonical reports route rejects invalid periods without logout',async()=>{
    const portal=require('../services/businessPortalService');
    const load=jest.spyOn(portal,'loadPageContext').mockRejectedValueOnce(new Error('INVALID_REPORT_DATE'));
    const res={status:jest.fn().mockReturnThis(),send:jest.fn(),redirect:jest.fn()};
    try{
        const layer=require('../routes/clientReports').stack.find(item=>item.route?.path==='/reports');
        await layer.route.stack.at(-1).handle({session:{accountType:'company'}},res);
        expect(res.status).toHaveBeenCalledWith(400);expect(res.redirect).not.toHaveBeenCalled();
    }finally{load.mockRestore();}
});
