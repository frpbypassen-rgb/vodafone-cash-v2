'use strict';

const fs = require('fs');
const path = require('path');
const {
    SYSTEM_TIME_ZONE,
    formatSystemDateTime,
    systemDateRange,
    systemDateParts
} = require('../config/systemTime');
const { preparePdfReport } = require('../services/reportPdfService');

describe('Libya system time and PDF report privacy', () => {
    test('formats operation timestamps with Libya time during Egypt daylight saving time', () => {
        const instant = new Date('2026-08-07T10:15:30.000Z');
        const parts = systemDateParts(instant);

        expect(SYSTEM_TIME_ZONE).toBe('Africa/Tripoli');
        expect(process.env.TZ).toBe('Africa/Tripoli');
        expect(parts).toMatchObject({
            year: '2026',
            month: '08',
            day: '07',
            hour: '12',
            minute: '15',
            second: '30'
        });
        expect(formatSystemDateTime(instant, 'en-GB', { hourCycle: 'h23' })).toContain('12:15');
    });

    test('builds daily database filters from Libya midnight boundaries', () => {
        const range = systemDateRange('2026-08-07', '2026-08-07');

        expect(range.$gte.toISOString()).toBe('2026-08-06T22:00:00.000Z');
        expect(range.$lte.toISOString()).toBe('2026-08-07T21:59:59.999Z');
        expect(systemDateRange('invalid', 'also-invalid')).toBeNull();
    });

    test('removes post-close notes from data sent to the PDF template', () => {
        const source = {
            closedDayChanges: [{ transactionId: 'TX-SECRET', details: 'display only' }],
            closure: { closedDayCount: 2, hasPostCloseChanges: true }
        };
        const prepared = preparePdfReport(source);

        expect(prepared.closedDayChanges).toEqual([]);
        expect(prepared.closure).toEqual({ closedDayCount: 2, hasPostCloseChanges: false });
        expect(source.closedDayChanges).toHaveLength(1);
    });

    test('keeps post-close notes in the screen report and excludes them from PDF markup', () => {
        const reportView = fs.readFileSync(path.join(__dirname, '..', 'views', 'reports.ejs'), 'utf8');
        const pdfView = fs.readFileSync(path.join(__dirname, '..', 'views', 'reports_pdf.ejs'), 'utf8');

        expect(reportView).toContain('ملاحظات ما بعد الإقفال');
        expect(pdfView).not.toContain('ملاحظات ما بعد الإقفال');
        expect(pdfView).not.toContain('report.closedDayChanges');
    });
});
