'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../models/ClientEmployee');
jest.mock('../models/ClientCompany');

const ClientEmployee = require('../models/ClientEmployee');
const ClientCompany = require('../models/ClientCompany');
const { loadCompanyAccess, findCompanyStaffTarget } = require('../services/companyAccessService');
const { attachCompanyAccess, requireCompanyCapability } = require('../middlewares/companyPortalGuard');
const { canAccessPage } = require('../services/businessPortalService');

const companyA = { _id: 'company-a', status: 'active' };
const companyB = { _id: 'company-b', status: 'active' };

const ownerA = {
    _id: 'owner-a',
    companyId: 'company-a',
    status: 'active',
    role: 'owner',
    sessionVersion: 0,
    name: 'مالك أ'
};
const employeeA = {
    _id: 'emp-a',
    companyId: 'company-a',
    status: 'active',
    role: 'employee',
    sessionVersion: 0,
    name: 'موظف أ'
};
const employeeB = {
    _id: 'emp-b',
    companyId: 'company-b',
    status: 'active',
    role: 'employee',
    sessionVersion: 0,
    name: 'موظف ب'
};

const buildApp = (capability) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        req.session = req.headers['x-session'] ? JSON.parse(req.headers['x-session']) : {};
        next();
    });
    app.get('/guarded', attachCompanyAccess, requireCompanyCapability(capability), (req, res) => {
        res.json({
            ok: true,
            role: req.companyAccess.role,
            companyId: String(req.companyAccess.companyId)
        });
    });
    return app;
};

describe('company portal route guards', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        ClientEmployee.findById = jest.fn((id) => {
            const row = [ownerA, employeeA, employeeB].find((item) => item._id === String(id));
            return Promise.resolve(row || null);
        });
        ClientCompany.findById = jest.fn((id) => {
            const row = [companyA, companyB].find((item) => item._id === String(id));
            return Promise.resolve(row || null);
        });
        ClientEmployee.findOne = jest.fn(async (query) => {
            return [ownerA, employeeA, employeeB].find((item) => (
                item._id === String(query._id) && item.companyId === String(query.companyId)
            )) || null;
        });
    });

    test('allows an authorized owner and denies an employee on a team endpoint', async () => {
        const app = buildApp('canManageTeam');
        const allowed = await request(app)
            .get('/guarded')
            .set('Accept', 'application/json')
            .set('x-session', JSON.stringify({
                isClientLoggedIn: true,
                accountType: 'company',
                clientId: 'owner-a',
                clientSessionVersion: 0
            }));
        expect(allowed.status).toBe(200);
        expect(allowed.body).toMatchObject({ ok: true, role: 'owner', companyId: 'company-a' });

        const denied = await request(app)
            .get('/guarded')
            .set('Accept', 'application/json')
            .set('x-session', JSON.stringify({
                isClientLoggedIn: true,
                accountType: 'company',
                clientId: 'emp-a',
                clientSessionVersion: 0
            }));
        expect(denied.status).toBe(403);
        expect(denied.body.error).toBe('FORBIDDEN');
    });

    test('cannot mutate or read a user outside the current company', async () => {
        const ctx = await loadCompanyAccess({
            session: {
                isClientLoggedIn: true,
                accountType: 'company',
                clientId: 'owner-a',
                clientSessionVersion: 0
            }
        });
        await expect(findCompanyStaffTarget({
            companyId: ctx.companyId,
            targetId: 'emp-b'
        })).rejects.toThrow('CROSS_COMPANY');
        await expect(findCompanyStaffTarget({
            companyId: ctx.companyId,
            targetId: 'emp-a'
        })).resolves.toMatchObject({ _id: 'emp-a', companyId: 'company-a' });
    });

    test('page guards cover allow, deny, and isolation of company data', () => {
        expect(canAccessPage({
            isCompany: true,
            permissions: { owner: true, manager: true, canCreateTransfer: true, canOpenOverview: true, canViewTeam: true, canViewReports: true, canViewBalance: true }
        }, 'overview')).toBe(true);
        expect(canAccessPage({
            isCompany: true,
            permissions: { employee: true, canTransfer: true, canOpenWorkspace: true }
        }, 'finance')).toBe(false);
        expect(canAccessPage({
            isCompany: true,
            permissions: { employee: true, canTransfer: true, canOpenWorkspace: true }
        }, 'staff')).toBe(false);
    });
});
