'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../models/Employee');
jest.mock('../services/mobileWebParityService', () => ({ getExecutorReports: jest.fn() }));
jest.mock('../mappers/mobileWebParityMapper', () => ({ toClientReportDto: jest.fn((report) => report) }));
jest.mock('../services/reportPdfService', () => ({ generateExecutorReportPdf: jest.fn() }));
jest.mock('../services/executorBalancePoolService', () => ({
    snapshotCompanyBalances: jest.fn(), workingBalanceForEmployee: jest.fn()
}));
jest.mock('../utils/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));

const Employee = require('../models/Employee');
const logger = require('../utils/logger');
const mobileWebParityService = require('../services/mobileWebParityService');
const { generateExecutorReportPdf } = require('../services/reportPdfService');
const { snapshotCompanyBalances, workingBalanceForEmployee } = require('../services/executorBalancePoolService');
const { clearExecutorAuthCache } = require('../services/executorAuthCache');
const executorPortalRouter = require('../routes/executorPortal');
const executorReportsRouter = require('../routes/executorReports');

const employee = {
    _id: 'manager-1',
    role: 'manager',
    status: 'active',
    groupId: { _id: 'group-1', status: 'active' }
};

const buildApp = ({ includePortal = false, session = {}, render } = {}) => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
        req.session = { isExecutorLoggedIn: true, executorId: 'manager-1', ...session };
        req.tenant = null;
        if (render) res.render = (view, locals) => {
            render(view, locals, req.session);
            res.json({ view, ...locals });
        };
        next();
    });
    if (includePortal) app.use('/executor-portal', executorPortalRouter);
    app.use('/executor-portal', executorReportsRouter);
    return app;
};

describe('executor web reports', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        clearExecutorAuthCache();
        Employee.findById.mockReturnValue({
            select: jest.fn().mockReturnValue({
                populate: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(employee) })
            }),
            populate: jest.fn().mockResolvedValue(employee)
        });
        mobileWebParityService.getExecutorReports.mockResolvedValue({
            scope: 'employee',
            reportPeriod: { value: '2026-08-19' },
            operations: []
        });
        snapshotCompanyBalances.mockResolvedValue({ available: 100 });
        workingBalanceForEmployee.mockResolvedValue(50);
    });

    test('renders reports once through the canonical portal route and consumes the MFA notice', async () => {
        const render = jest.fn();
        const response = await request(buildApp({
            includePortal: true, session: { showMfaEnableNotice: true }, render
        })).get('/executor-portal/reports');

        expect(response.status).toBe(200);
        expect(render).toHaveBeenCalledTimes(1);
        expect(render).toHaveBeenCalledWith('executor/reports', {
            emp: employee, showMfaNotice: true, companyBalances: { available: 100 }, workingBalance: null
        }, expect.not.objectContaining({ showMfaEnableNotice: true }));
        expect(snapshotCompanyBalances).toHaveBeenCalledTimes(1);
        expect(snapshotCompanyBalances).toHaveBeenCalledWith(employee.groupId);
        expect(workingBalanceForEmployee).not.toHaveBeenCalled();
        expect(mobileWebParityService.getExecutorReports).not.toHaveBeenCalled();
    });

    test('the API reports router has no second page renderer', async () => {
        const render = jest.fn();
        const response = await request(buildApp({ render })).get('/executor-portal/reports');
        expect(response.status).toBe(404);
        expect(render).not.toHaveBeenCalled();
        expect(Employee.findById).not.toHaveBeenCalled();
    });

    test('preserves the MFA enrollment guard on the canonical report page', async () => {
        const render = jest.fn();
        const response = await request(buildApp({
            includePortal: true, session: { mfaEnrollmentRequired: true }, render
        })).get('/executor-portal/reports');
        expect(response.status).toBe(302);
        expect(response.headers.location).toBe('/security/mfa-enroll');
        expect(render).not.toHaveBeenCalled();
        expect(snapshotCompanyBalances).not.toHaveBeenCalled();
    });

    test('preserves session revocation before rendering the report page', async () => {
        const render = jest.fn();
        const response = await request(buildApp({
            includePortal: true, session: { executorSessionVersion: 1 }, render
        })).get('/executor-portal/reports');
        expect(response.status).toBe(302);
        expect(response.headers.location).toBe('/login');
        expect(render).not.toHaveBeenCalled();
        expect(snapshotCompanyBalances).not.toHaveBeenCalled();
    });

    test.each(['accountant', 'external', 'operator'])(
        'preserves report balance visibility for an %s', async (role) => {
            const emp = { ...employee, role };
            Employee.findById.mockReturnValue({
                select: jest.fn().mockReturnValue({
                    populate: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(emp) })
                })
            });
            const render = jest.fn();
            const response = await request(buildApp({ includePortal: true, render }))
                .get('/executor-portal/reports');
            expect(response.status).toBe(200);
            expect(render).toHaveBeenCalledTimes(1);
            expect(response.body).toMatchObject({
                showMfaNotice: false,
                companyBalances: role === 'accountant' ? { available: 100 } : null,
                workingBalance: role === 'external' ? 50 : null
            });
            expect(snapshotCompanyBalances).toHaveBeenCalledTimes(role === 'accountant' ? 1 : 0);
            expect(workingBalanceForEmployee).toHaveBeenCalledTimes(role === 'external' ? 1 : 0);
        }
    );

    test('keeps rendering the report page when the balance snapshot is unavailable', async () => {
        snapshotCompanyBalances.mockRejectedValueOnce(new Error('balance unavailable'));
        const render = jest.fn();
        const response = await request(buildApp({ includePortal: true, render }))
            .get('/executor-portal/reports');
        expect(response.status).toBe(200);
        expect(response.body.companyBalances).toBeNull();
        expect(render).toHaveBeenCalledTimes(1);
    });

    test('passes the selected employee scope to the server report service', async () => {
        const response = await request(buildApp({ includePortal: true }))
            .post('/executor-portal/reports/filter')
            .send({ dateType: 'day', dateValue: '2026-08-19', employeeId: 'employee-2' });

        expect(response.status).toBe(200);
        expect(mobileWebParityService.getExecutorReports).toHaveBeenCalledWith(expect.objectContaining({
            executorId: 'manager-1',
            employeeId: 'employee-2',
            dateType: 'day',
            dateValue: '2026-08-19'
        }));
    });

    test('rejects a report request from a session predating a password change', async () => {
        Employee.findById.mockReturnValue({
            select: jest.fn().mockReturnValue({
                populate: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ ...employee, sessionVersion: 1 }) })
            }),
            populate: jest.fn().mockResolvedValue({ ...employee, sessionVersion: 1 })
        });

        const response = await request(buildApp()).post('/executor-portal/reports/filter').send({ dateType: 'day' });

        expect(response.status).toBe(401);
        expect(mobileWebParityService.getExecutorReports).not.toHaveBeenCalled();
    });

    test('returns 413 when a report exceeds the safe row limit', async () => {
        mobileWebParityService.getExecutorReports.mockRejectedValue(new Error('REPORT_TOO_LARGE'));

        const response = await request(buildApp()).post('/executor-portal/reports/filter').send({ dateType: 'all' });

        expect(response.status).toBe(413);
    });

    test.each(['constructor', '__proto__', 'toString', 'mongodb://user:secret@internal-host'])(
        'uses a sanitized 500 response for an unknown report error: %s', async (message) => {
            mobileWebParityService.getExecutorReports.mockRejectedValueOnce(new Error(message));
            const response = await request(buildApp()).post('/executor-portal/reports/filter').send({});
            expect(response.status).toBe(500);
            expect(response.body).toEqual({ success: false, error: 'تعذر تجهيز تقرير التنفيذ.' });
            expect(logger.error).toHaveBeenCalledWith('Executor reports failed', {
                errorType: 'Error', databaseCode: undefined
            });
            expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
        }
    );

    test('lists only same-group employees with read-only report fields', async () => {
        const lean = jest.fn().mockResolvedValue([
            { _id: 'employee-2', name: 'موظف', role: 'operator', webPassword: 'hidden' }
        ]);
        const select = jest.fn().mockReturnValue({ lean });
        Employee.find.mockReturnValue({ select });

        const response = await request(buildApp()).get('/executor-portal/reports/employees');

        expect(response.status).toBe(200);
        expect(Employee.find).toHaveBeenCalledWith({ groupId: 'group-1', role: { $ne: 'manager' } });
        expect(select).toHaveBeenCalledWith('_id name role');
        expect(response.body.employees).toEqual([{ id: 'employee-2', name: 'موظف', role: 'operator' }]);
    });

    test('does not expose the employee list to an operator', async () => {
        Employee.findById.mockReturnValue({
            select: jest.fn().mockReturnValue({
                populate: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ ...employee, role: 'operator' }) })
            })
        });

        const response = await request(buildApp()).get('/executor-portal/reports/employees');

        expect(response.status).toBe(403);
        expect(Employee.find).not.toHaveBeenCalled();
    });

    test('allows an accountant to read the same-group employee list', async () => {
        Employee.findById.mockReturnValue({
            select: jest.fn().mockReturnValue({
                populate: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ ...employee, role: 'accountant' }) })
            })
        });
        Employee.find.mockReturnValue({
            select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) })
        });

        const response = await request(buildApp()).get('/executor-portal/reports/employees');

        expect(response.status).toBe(200);
        expect(Employee.find).toHaveBeenCalledWith({ groupId: 'group-1', role: { $ne: 'manager' } });
    });

    test('passes a phone or amount search through to the scoped report service', async () => {
        const response = await request(buildApp())
            .post('/executor-portal/reports/filter')
            .send({ dateType: 'all', search: '01001352034' });

        expect(response.status).toBe(200);
        expect(mobileWebParityService.getExecutorReports).toHaveBeenCalledWith(expect.objectContaining({
            executorId: 'manager-1',
            dateType: 'all',
            search: '01001352034'
        }));
    });

    test('downloads the same server-rendered executor PDF used by the app', async () => {
        generateExecutorReportPdf.mockResolvedValue(Buffer.from('%PDF-test'));

        const response = await request(buildApp({ includePortal: true }))
            .post('/executor-portal/reports/download.pdf')
            .send({ dateType: 'day', dateValue: '2026-08-19', employeeId: 'employee-2' });

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('application/pdf');
        expect(generateExecutorReportPdf).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            report: expect.objectContaining({ scope: 'employee' }),
            generatedAt: expect.any(Date)
        }));
    });

    test('returns a retryable response when PDF rendering is saturated', async () => {
        generateExecutorReportPdf.mockRejectedValue(Object.assign(new Error('PDF_BUSY'), { code: 'PDF_BUSY' }));

        const response = await request(buildApp()).post('/executor-portal/reports/download.pdf').send({ dateType: 'day' });

        expect(response.status).toBe(429);
        expect(response.body.success).toBe(false);
    });
});
