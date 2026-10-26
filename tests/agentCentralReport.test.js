'use strict';
jest.mock('../services/adminReportService',()=>({...jest.requireActual('../services/adminReportService'),loadAdminReport:jest.fn()}));
jest.mock('../services/reportPdfService',()=>({generateAdminReportPdf:jest.fn(async()=>Buffer.from('admin-pdf'))}));
const {centralAgentReportInput,createCentralAgentReportPdf}=require('../services/agentCentralReportService');
const {loadAdminReport}=require('../services/adminReportService');
const {generateAdminReportPdf}=require('../services/reportPdfService');
const workspace={isAgent:true,entity:{_id:'agency-a',tenantId:'tenant-a'},permissions:{canViewReports:true,canViewBalance:true,canViewAllReports:true}};
beforeEach(()=>jest.clearAllMocks());
test('month download is locked to the authenticated agency and administration source',async()=>{
    const report={scope:{mainCategory:'agent',subId:'agency-a'}};loadAdminReport.mockResolvedValue(report);
    const result=await createCentralAgentReportPdf(workspace,{month:'2026-10',subId:'foreign',tenantId:'foreign',mainCategory:'company',scope:'staff',search:'ignored'});
    expect(result.pdf).toEqual(Buffer.from('admin-pdf'));
    expect(loadAdminReport).toHaveBeenCalledWith({mainCategory:'agent',subId:'agency-a',subType:'all',tenantId:'tenant-a',dateType:'month',dateValue:'2026-10'},{readOnly:true});
    expect(generateAdminReportPdf).toHaveBeenCalledWith(expect.objectContaining({render:expect.any(Function)}),{report,generatedAt:expect.any(Date),adminName:'الإدارة'});
});
test('one selected date maps to an administration daily statement',()=>{
    expect(centralAgentReportInput(workspace,{from:'2026-10-25',to:'2026-10-25'})).toMatchObject({dateType:'day',dateValue:'2026-10-25'});
});
test('a custom period preserves both date boundaries',()=>{
    expect(centralAgentReportInput(workspace,{from:'2026-10-01',to:'2026-10-25'})).toMatchObject({dateType:'range',dateFrom:'2026-10-01',dateTo:'2026-10-25'});
});
test.each([{month:'2026-13'},{from:'2026-02-30',to:'2026-03-01'},{from:'2026-10-25',to:'2026-10-01'}])('invalid periods are rejected: %j',query=>{
    expect(()=>centralAgentReportInput(workspace,query)).toThrow('INVALID_REPORT_DATE');
});
test.each(['canViewReports','canViewBalance','canViewAllReports'])('comprehensive PDF requires %s',key=>{
    expect(()=>centralAgentReportInput({...workspace,permissions:{...workspace.permissions,[key]:false}},{month:'2026-10'})).toThrow('REPORT_FORBIDDEN');
    expect(loadAdminReport).not.toHaveBeenCalled();
});
