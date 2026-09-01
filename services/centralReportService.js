'use strict';

const crypto = require('crypto');

const csvValue = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

const buildArtifact = ({ workspace, report, issuedAt = new Date() }) => {
    const issuedAtIso = new Date(issuedAt).toISOString();
    const payload = JSON.stringify({
        entityId: String(workspace.entity?._id || ''),
        scope: report.reportScope,
        period: report.filters?.label || '',
        issuedAt: issuedAtIso,
        total: report.reportSummary?.totalCount || 0,
        rows: report.reportRows?.map((row) => [row.key, row.totalCount, row.completedCount, row.totalEGP]) || []
    });
    const checksum = crypto.createHash('sha256').update(payload).digest('hex').slice(0, 16).toUpperCase();
    return {
        source: 'الإدارة المركزية — Power Pay AL-Ahram',
        issuedAt: issuedAtIso,
        reportId: `RPT-${issuedAtIso.replace(/[-:.TZ]/g, '').slice(0, 14)}-${checksum.slice(0, 6)}`,
        checksum: `SHA-256:${checksum}`
    };
};

const buildCsv = ({ workspace, report, artifact }) => {
    const canViewBalance = Boolean(workspace.permissions?.canViewBalance);
    const canViewAgencyProfit = Boolean(workspace.isAgent && canViewBalance);
    const headers = canViewBalance
        ? ['البند', 'إجمالي العمليات', 'الناجحة', 'قيد التنفيذ', 'الملغية', 'إجمالي EGP', 'إجمالي LYD', 'الإيداعات', 'الخصومات', ...(canViewAgencyProfit ? ['ربح الوكالة المحقق', 'ربح متوقع', 'ربح مستبعد'] : []), 'آخر حركة']
        : ['البند', 'إجمالي العمليات', 'الناجحة', 'قيد التنفيذ', 'الملغية', 'إجمالي EGP', 'آخر حركة'];
    const lines = [
        ['مصدر التقرير', artifact.source],
        ['رقم التقرير', artifact.reportId],
        ['وقت الإصدار UTC', artifact.issuedAt],
        ['بصمة التحقق', artifact.checksum],
        ['الشركة / الجهة', workspace.entity?.name || ''],
        ['نطاق التقرير', report.reportScopeLabel || ''],
        ['الفترة', report.filters?.label || ''],
        [],
        headers
    ].map((line) => line.map(csvValue).join(','));
    report.reportRows.forEach((row) => {
        const values = [row.key, row.totalCount, row.completedCount, row.pendingCount, row.cancelledCount, row.totalEGP];
        if (canViewBalance) values.push(row.totalLYD, row.deposits, row.deductions);
        if (canViewAgencyProfit) values.push(row.realizedProfit || 0, row.expectedProfit || 0, row.reversedProfit || 0);
        values.push(row.lastActivity ? new Date(row.lastActivity).toISOString() : '');
        lines.push(values.map(csvValue).join(','));
    });
    return `\uFEFF${lines.join('\n')}`;
};

module.exports = { buildArtifact, buildCsv };
