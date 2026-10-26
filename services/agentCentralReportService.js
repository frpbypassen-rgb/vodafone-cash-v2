'use strict';
const path = require('node:path');
const ejs = require('ejs');
const { loadAdminReport, getDateRange } = require('./adminReportService');
const { generateAdminReportPdf } = require('./reportPdfService');
const { systemDateKey, systemDayStart } = require('../config/systemTime');
const { canReceiveAgencyStatement } = require('../utils/agentReportEmailAccess');
const centralAgentReportInput = (workspace, query = {}) => {
    if (!canReceiveAgencyStatement(workspace)) throw Object.assign(new Error('REPORT_FORBIDDEN'), {statusCode:403});
    const today = systemDateKey(new Date());
    let period;
    if (workspace.forceToday || query.period === 'today') period = getDateRange('day',today);
    else if (query.period === 'week') period = getDateRange('range','',systemDateKey(new Date(systemDayStart(today).getTime()-6*86400000)),today);
    else if (query.from || query.to || query.date) {
        const from = String(query.from || query.date || query.to);
        const to = String(query.to || query.date || query.from);
        period = from === to ? getDateRange('day',from) : getDateRange('range','',from,to);
    } else period = getDateRange('month',String(query.month || today.slice(0,7)));
    return {mainCategory:'agent',subId:String(workspace.entity._id),subType:'all',tenantId:workspace.entity.tenantId || null,dateType:period.dateType,dateValue:period.dateValue,...(period.dateType === 'range' ? {dateFrom:period.dateFrom,dateTo:period.dateTo} : {})};
};
const renderer = { render:(view,data,callback)=>ejs.renderFile(path.join(__dirname,'../views',view+'.ejs'),data,callback) };
const createCentralAgentReportPdf = async (workspace,query) => {
    const input = centralAgentReportInput(workspace,query);
    const report = await loadAdminReport(input,{readOnly:true});
    const pdf = await generateAdminReportPdf(renderer,{report,generatedAt:new Date(),adminName:'الإدارة'});
    return {input,pdf};
};
module.exports = { centralAgentReportInput, createCentralAgentReportPdf };
