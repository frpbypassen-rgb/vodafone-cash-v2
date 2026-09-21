'use strict';

const fs = require('fs');
const path = require('path');
const { toExecutorPortalTaskDto, portalLiveTaskNotes } = require('../utils/executorTaskPrivacy');
const { executorTaskIndexes } = require('../services/performanceIndexService');

const dashboardSource = fs.readFileSync(path.join(__dirname, '../views/executor/dashboard.ejs'), 'utf8');
const csrfSource = fs.readFileSync(path.join(__dirname, '../middlewares/csrfProtection.js'), 'utf8');
const overviewSource = fs.readFileSync(path.join(__dirname, '../services/mobileWebParityService.js'), 'utf8');

describe('executor portal performance contracts', () => {
    test('dashboard idle polls use lite live-tasks and a server-driven interval', () => {
        expect(dashboardSource).toContain('/executor-portal/api/live-tasks?lite=1');
        expect(dashboardSource).toContain('pollIntervalSeconds');
        expect(dashboardSource).toContain('scheduleLiveTasksPoll');
        expect(dashboardSource).not.toMatch(/setInterval\(refreshVisibleExecutorTasks,\s*8000\)/);
        expect(dashboardSource).toContain('preload="none"');
        expect(dashboardSource).toContain('معلّقة عنده');
        expect(dashboardSource).toContain('بدأ التنفيذ');
        expect(dashboardSource).toContain('اسحب المهمة الموجهة إليك');
        expect(dashboardSource).toContain('منفّذ خارجي');
        expect(dashboardSource).toContain('تنفيذ سريع');
        expect(dashboardSource).toContain('fa-phone-flip');
        expect(dashboardSource).toContain('/executor-portal/api/quick-execute/dial/');
        expect(dashboardSource).toContain('encodeQuickExecuteTelUri');
        expect(dashboardSource).toContain('%2A');
        expect(dashboardSource).toContain('canClaimThenQuickExecute');
        expect(dashboardSource).toContain('executor-sla-hint');
        expect(dashboardSource).toContain('STUCK_ASSIGNEE_SLA_SECONDS');
    });

    test('live-task notes drop the API terminal log before it is sent to the browser', () => {
        const notes = 'رقم المحول: 011\n--- سجل الـ API (Terminal Log) ---\n'.padEnd(5000, 'x');
        expect(portalLiveTaskNotes(notes)).not.toContain('سجل الـ API');
        expect(portalLiveTaskNotes(notes).length).toBeLessThan(500);
        const dto = toExecutorPortalTaskDto({ notes, status: 'processing', amount: 10 }, 'employee-1');
        expect(dto.notes).not.toContain('Terminal Log');
    });

    test('overview counts completed work with aggregates instead of loading month-wide documents', () => {
        const start = overviewSource.indexOf('async function getExecutorOverview');
        const end = overviewSource.indexOf('async function getLegacyExecutorReports');
        const body = overviewSource.slice(start, end);
        expect(body).toContain('aggregateExecutorCompletedStats');
        expect(body).not.toContain('findReportTransactions');
    });

    test('CSRF HTML rewriting skips JSON live-task payloads', () => {
        expect(csrfSource).toContain("!contentType.includes('application/json')");
    });

    test('creates executor completed-today and web-alert indexes at boot', () => {
        expect(executorTaskIndexes).toEqual(expect.arrayContaining([
            expect.objectContaining({ name: 'executorGroupId_1_status_1_completedAt_-1' }),
            expect.objectContaining({ name: 'operatorId_1_status_1_completedAt_-1' }),
            expect.objectContaining({ name: 'executorPortal_webAlert_executorGroup' })
        ]));
    });
});
