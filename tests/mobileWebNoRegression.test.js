// tests/mobileWebNoRegression.test.js
// ===============================================
// 🛡️ Regression Guard — حماية الويب من التداخل مع الموبايل
// ===============================================
'use strict';

const fs = require('fs');
const path = require('path');

describe('🛡️ Regression Guard: Web Routes Independence', () => {
    test('T042: Web routes must not import mobile DTO mappers directly to prevent side effects', () => {
        const webRoutes = [
            'adminClosing.js',
            'adminReports.js',
            'adminTransactions.js',
            'auditLog.js',
            'auth.js',
            'botApi.js',
            'broadcast.js',
            'clientPortal.js',
            'clients.js',
            'dashboard.js',
            'employees.js',
            'executorPortal.js',
            'executors.js',
            'index.js',
            'merchantApi.js',
            'settings.js',
            'support.js'
        ];

        webRoutes.forEach(filename => {
            const filePath = path.join(__dirname, '../routes', filename);
            if (fs.existsSync(filePath)) {
                const content = fs.readFileSync(filePath, 'utf8');
                // Ensure they do not require any mobile mappers
                expect(content).not.toContain('mappers/mobile');
                expect(content).not.toContain('mobileAuthMapper');
                expect(content).not.toContain('mobileErrorMapper');
                expect(content).not.toContain('mobileTransactionMapper');
                expect(content).not.toContain('mobileExecutorMapper');
            }
        });
    });
});
