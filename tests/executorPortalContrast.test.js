'use strict';

const fs = require('fs');
const path = require('path');

const read = (relativePath) => fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');

describe('executor portal contrast and theme boot', () => {
    test('reports apply the saved theme before the body paints', () => {
        const reports = read('views/executor/reports.ejs');
        const themeBoot = reports.indexOf('/js/executor/dashboard/theme-init.js');
        expect(themeBoot).toBeGreaterThan(-1);
        expect(themeBoot).toBeLessThan(reports.indexOf('<body'));
        expect(read('public/js/executor/dashboard/theme-init.js')).toContain("setAttribute('data-theme'");
    });

    test('locked task cards keep full opacity and status badges include words', () => {
        const sheets = [
            'public/css/executor-workspace.css',
            'public/css/executor-2030-override.css',
            'public/css/executor-dashboard-mobile.css'
        ].map(read).join('\n');
        expect(sheets).not.toMatch(/task-card\.task-locked[\s\S]{0,180}opacity:\s*0\./);
        expect(sheets).toMatch(/task-card\.task-locked[\s\S]{0,220}opacity:\s*1/);
        const tasks = read('public/js/executor/dashboard/tasks.js');
        expect(tasks).toContain('بدأ التنفيذ');
        expect(tasks).toContain('متاح');
        expect(tasks).toContain('إنهاء العملية');
        expect(tasks).toContain('اسحب ونفذ فوراً');
    });
});
