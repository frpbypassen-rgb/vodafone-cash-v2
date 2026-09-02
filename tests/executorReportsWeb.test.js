'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../models/Employee');
jest.mock('../services/mobileWebParityService', () => ({ getExecutorReports: jest.fn() }));
jest.mock('../mappers/mobileWebParityMapper', () => ({ toClientReportDto: jest.fn((report) => report) }));
jest.mock('../services/reportPdfService', () => ({ generateExecutorReportPdf: jest.fn() }));

const Employee = require('../models/Employee');
const mobileWebParityService = require('../services/mobileWebParityService');
const { generateExecutorReportPdf } = require('../services/reportPdfService');
const executorReportsRouter = require('../routes/executorReports');

const employee = {
    _id: 'manager-1',
    role: 'manager',
    status: 'active',
    groupId: { _id: 'group-1', status: 'active' }
};

const buildApp = () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = { isExecutorLoggedIn: true, executorId: 'manager-1' };
        req.tenant = null;
        next();
    });
    app.use('/executor-portal', executorReportsRouter);
    return app;
};

describe('executor web reports', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        Employee.findById.mockReturnValue({ populate: jest.fn().mockResolvedValue(employee) });
        mobileWebParityService.getExecutorReports.mockResolvedValue({
            scope: 'employee',
            reportPeriod: { value: '2026-08-19' },
            operations: []
        });
    });

    test('passes the selected employee scope to the server report service', async () => {
        const response = await request(buildApp())
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

        const response = await request(buildApp())
            .post('/executor-portal/reports/download.pdf')
            .send({ dateType: 'day', dateValue: '2026-08-19', employeeId: 'employee-2' });

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain('application/pdf');
        expect(generateExecutorReportPdf).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
            report: expect.objectContaining({ scope: 'employee' }),
            generatedAt: expect.any(Date)
        }));
    });
});
