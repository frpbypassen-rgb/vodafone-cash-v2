'use strict';
const path = require('path');
const ejs = require('ejs');
const { loadAdminReport } = require('./adminReportService');
const { generateAdminReportPdf } = require('./reportPdfService');
const { systemDayStart, systemDateKey } = require('../config/systemTime');
const { canReceiveAgencyStatement } = require('../utils/agentReportEmailAccess');

const previousDay = (now = new Date()) => systemDateKey(new Date(systemDayStart(systemDateKey(now)).getTime() - 1));
const statementInput = (workspace, day) => {
    if (!canReceiveAgencyStatement(workspace)) throw Object.assign(new Error('REPORT_FORBIDDEN'), { statusCode: 403 });
    if (!systemDayStart(day)) throw new Error('INVALID_REPORT_DAY');
    return { mainCategory: 'agent', subId: String(workspace.entity._id), subType: 'all', dateType: 'day', dateValue: day, tenantId: workspace.entity.tenantId || null };
};
const loadStatement = (workspace, day) => loadAdminReport(statementInput(workspace, day), { readOnly: true });
const renderer = {
    render: (view, data, callback) => ejs.renderFile(path.join(__dirname, '../views', view + '.ejs'), data, callback),
};
const createStatementPdf = async (workspace, day) => {
    const report = await loadStatement(workspace, day);
    return generateAdminReportPdf(renderer, { report, generatedAt: new Date(), adminName: 'الإدارة' });
};
module.exports = { previousDay, statementInput, loadStatement, createStatementPdf };
