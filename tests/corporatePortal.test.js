'use strict';

jest.mock('../models/ClientEmployee', () => ({ findById: jest.fn(), find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/ClientCompany', () => ({ findById: jest.fn() }));
jest.mock('../models/CompanyProfile', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));
jest.mock('../models/CorporateBeneficiary', () => {
    const Model = jest.fn();
    Model.findOne = jest.fn();
    Model.find = jest.fn();
    Model.create = jest.fn();
    Model.encryptAccountNumber = jest.fn(() => ({ accountNumberEncrypted: 'enc', accountNumberLast4: '5432' }));
    return Model;
});
jest.mock('../models/CorporatePaymentRequest', () => {
    const Model = jest.fn();
    Model.findOne = jest.fn();
    Model.find = jest.fn();
    Model.create = jest.fn();
    Model.aggregate = jest.fn().mockResolvedValue([]);
    return Model;
});
jest.mock('../models/CorporateInvoice', () => ({ find: jest.fn(), create: jest.fn() }));
jest.mock('../models/Ledger', () => ({ findOne: jest.fn(), find: jest.fn() }));
jest.mock('../models/AuditLog', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../services/auditService', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/walletService', () => ({
    updateBalanceWithLedger: jest.fn().mockResolvedValue({ success: true, balanceBefore: 1000, balanceAfter: 500 })
}));
jest.mock('../services/passkeyService', () => ({
    authenticationOptions: jest.fn(),
    verifyAuthentication: jest.fn()
}));
jest.mock('../models/SecurityDevice', () => ({ find: jest.fn(), findOne: jest.fn() }));

const {
    resolveCorporateRole,
    permissionsForRole,
    resolveApprovalLimit,
    isCorporatePortalEnabled
} = require('../services/corporateRoleService');
const {
    requireCorporateRole,
    requireSameCompany,
    requireCorporatePermission
} = require('../middlewares/corporateAuth');
const { needsManagerApproval } = require('../services/corporateApprovalService');
const { logAction } = require('../services/auditService');
const approvalService = require('../services/corporateApprovalService');
const CorporateBeneficiary = require('../models/CorporateBeneficiary');
const CorporatePaymentRequest = require('../models/CorporatePaymentRequest');
const { scopedFilter } = require('../services/corporateReportService');
const { detectCorporateView } = require('../middlewares/corporateAuth');
const corporateApi = require('../routes/corporateApi');

const jsonRes = () => {
    const res = {
        status: jest.fn(() => res),
        json: jest.fn(() => res),
        render: jest.fn(() => res),
        redirect: jest.fn(() => res)
    };
    return res;
};

const runRoute = (method, path, req) => new Promise((resolve, reject) => {
    const layer = corporateApi.stack.find((item) => (
        item.route
        && item.route.path === path
        && item.route.methods[method]
    ));
    if (!layer) return reject(new Error(`Missing route ${method} ${path}`));
    const res = jsonRes();
    const stack = layer.route.stack;
    let index = 0;
    const next = (error) => {
        if (error) return reject(error);
        const handler = stack[index++];
        if (!handler) return resolve(res);
        try {
            const result = handler.handle(req, res, next);
            if (result && typeof result.then === 'function') {
                result.then(() => {
                    if (res.status.mock.calls.length || res.json.mock.calls.length) resolve(res);
                }).catch(reject);
            } else if (res.status.mock.calls.length || res.json.mock.calls.length) {
                resolve(res);
            }
        } catch (caught) {
            reject(caught);
        }
    };
    next();
});

describe('corporate RBAC helpers', () => {
    test('maps existing company flags onto the three corporate roles', () => {
        expect(resolveCorporateRole({ corporateRole: 'manager' })).toBe('manager');
        expect(resolveCorporateRole({ role: 'accountant' })).toBe('accountant');
        expect(resolveCorporateRole({ role: 'owner' })).toBe('manager');
        expect(resolveCorporateRole({ role: 'employee', canManageCompany: true })).toBe('manager');
        expect(resolveCorporateRole({ role: 'employee', canViewAllReports: true })).toBe('manager');
        expect(resolveCorporateRole({ role: 'employee' })).toBe('employee');
    });

    test('permission matrix is fail-closed across roles', () => {
        const manager = permissionsForRole('manager');
        const employee = permissionsForRole('employee');
        const accountant = permissionsForRole('accountant');

        expect(manager.canApprove).toBe(true);
        expect(manager.canAddBeneficiaries).toBe(true);
        expect(employee.canApprove).toBe(false);
        expect(employee.canAddBeneficiaries).toBe(false);
        expect(employee.canViewAllOps).toBe(false);
        expect(accountant.canTransfer).toBe(false);
        expect(accountant.canExport).toBe(true);
        expect(accountant.canReconcile).toBe(true);
        expect(accountant.canApprove).toBe(false);
    });

    test('approval limit prefers the actor field then company defaults', () => {
        expect(resolveApprovalLimit({ corporateRole: 'employee', approvalLimit: 250 }, { defaultEmployeeApprovalLimit: 100 })).toBe(250);
        expect(resolveApprovalLimit({ corporateRole: 'employee' }, { defaultEmployeeApprovalLimit: 100 })).toBe(100);
        expect(resolveApprovalLimit({ corporateRole: 'accountant' }, {})).toBe(0);
    });

    test('portal stays disabled unless company or actor flags are on', () => {
        expect(isCorporatePortalEnabled({ actor: {}, company: {}, profile: null })).toBe(false);
        expect(isCorporatePortalEnabled({ actor: { corporatePortalEnabled: true }, company: {}, profile: null })).toBe(true);
        expect(isCorporatePortalEnabled({ actor: {}, company: { corporatePortal: { enabled: true } }, profile: null })).toBe(true);
    });
});

describe('corporate middleware fail-closed', () => {
    test('employee cannot hit manager or accountant routes', () => {
        const req = { corporate: { role: 'employee' }, headers: { accept: 'application/json' }, originalUrl: '/api/corporate/x' };
        const res = jsonRes();
        requireCorporateRole(['manager'])(req, res, () => { throw new Error('should not pass'); });
        expect(res.status).toHaveBeenCalledWith(403);
        requireCorporateRole(['accountant'])(req, res, () => { throw new Error('should not pass'); });
        expect(res.status).toHaveBeenCalledWith(403);
    });

    test('accountant cannot transfer', () => {
        const req = {
            corporate: { role: 'accountant', permissions: permissionsForRole('accountant') },
            headers: { accept: 'application/json' },
            originalUrl: '/api/corporate/requests'
        };
        const res = jsonRes();
        requireCorporatePermission('canTransfer')(req, res, () => { throw new Error('should not pass'); });
        expect(res.status).toHaveBeenCalledWith(403);
    });

    test('company A cannot address company B', () => {
        const req = {
            corporate: { companyId: 'aaa' },
            params: { companyId: 'bbb' },
            headers: { accept: 'application/json' },
            originalUrl: '/api/corporate/dashboard'
        };
        const res = jsonRes();
        requireSameCompany(req, res, () => { throw new Error('should not pass'); });
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'CORPORATE_COMPANY_MISMATCH' }));
    });

    test('same-company requests continue', () => {
        const req = {
            corporate: { companyId: 'aaa' },
            body: { companyId: 'aaa' },
            headers: { accept: 'application/json' }
        };
        const next = jest.fn();
        requireSameCompany(req, jsonRes(), next);
        expect(next).toHaveBeenCalled();
    });
});

describe('approval thresholds', () => {
    test('employee amount above limit requires manager approval', () => {
        expect(needsManagerApproval({
            amount: 800,
            actor: { corporateRole: 'employee', approvalLimit: 500 },
            profile: {}
        })).toBe(true);
        expect(needsManagerApproval({
            amount: 200,
            actor: { corporateRole: 'employee', approvalLimit: 500 },
            profile: {}
        })).toBe(false);
    });

    test('manager stays inside their own limit without extra approval', () => {
        expect(needsManagerApproval({
            amount: 1500,
            actor: { corporateRole: 'manager', approvalLimit: 2000 },
            profile: {}
        })).toBe(false);
    });
});

describe('company isolation of reports', () => {
    test('employee queries are scoped to self and company', () => {
        const filter = scopedFilter({
            companyId: 'comp-a',
            actor: { _id: 'emp-1' },
            permissions: permissionsForRole('employee')
        });
        expect(filter.companyId).toBe('comp-a');
        expect(filter.requesterId).toBe('emp-1');
    });

    test('accountant sees the whole company but still a single companyId', () => {
        const filter = scopedFilter({
            companyId: 'comp-a',
            actor: { _id: 'acc-1' },
            permissions: permissionsForRole('accountant')
        });
        expect(filter.companyId).toBe('comp-a');
        expect(filter.requesterId).toBeUndefined();
    });
});

describe('corporate mutations write audit entries', () => {
    const context = {
        actor: { _id: 'mgr-1', name: 'مدير' },
        company: { _id: 'comp-1', balance: 9000, creditLimit: 0, corporatePortal: {} },
        profile: { defaultEmployeeApprovalLimit: 0 },
        role: 'manager',
        permissions: permissionsForRole('manager'),
        companyId: 'comp-1',
        tenantId: undefined
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('approve writes CORPORATE_TRANSFER_APPROVED and executes once', async () => {
        const request = {
            _id: 'req-1',
            companyId: 'comp-1',
            status: 'pending_approval',
            requesterId: 'emp-1',
            amount: 700,
            reference: 'CORP-TEST-1',
            beneficiarySnapshot: { name: 'مورد' },
            save: jest.fn().mockResolvedValue(true)
        };
        CorporatePaymentRequest.findOne.mockResolvedValue(request);
        const result = await approvalService.decideRequest({
            context,
            requestId: 'req-1',
            decision: 'approve',
            req: { headers: {}, method: 'POST', originalUrl: '/api/corporate/requests/req-1/approve' }
        });
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CORPORATE_TRANSFER_APPROVED' }));
        expect(result.request.status).toBe('executed');
    });

    test('reject writes CORPORATE_TRANSFER_REJECTED', async () => {
        const request = {
            _id: 'req-2',
            companyId: 'comp-1',
            status: 'pending_approval',
            requesterId: 'emp-1',
            reference: 'CORP-TEST-2',
            save: jest.fn().mockResolvedValue(true)
        };
        CorporatePaymentRequest.findOne.mockResolvedValue(request);
        await approvalService.decideRequest({
            context,
            requestId: 'req-2',
            decision: 'reject',
            reason: 'تجاوز السياسة',
            req: { headers: {}, method: 'POST', originalUrl: '/api/corporate/requests/req-2/reject' }
        });
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CORPORATE_TRANSFER_REJECTED' }));
        expect(request.status).toBe('rejected');
    });
});

describe('view detection', () => {
    test('honors ?view= override and UA fallback', () => {
        const session = {};
        expect(detectCorporateView({ query: { view: 'mobile' }, session, headers: {} })).toBe('mobile');
        expect(session.corporateView).toBe('mobile');
        expect(detectCorporateView({
            query: {},
            session: {},
            headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)' }
        })).toBe('mobile');
        expect(detectCorporateView({
            query: {},
            session: {},
            headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0)' }
        })).toBe('desktop');
    });
});

describe('API route matrix', () => {
    test('employee hitting accountant reconcile is 403', async () => {
        const res = await runRoute('post', '/requests/:id/reconcile', {
            corporate: { role: 'employee', permissions: permissionsForRole('employee'), companyId: 'c1' },
            headers: { accept: 'application/json' },
            originalUrl: '/api/corporate/requests/1/reconcile',
            params: { id: '1' },
            body: {}
        });
        expect(res.status).toHaveBeenCalledWith(403);
    });

    test('employee hitting beneficiary create is 403', async () => {
        const res = await runRoute('post', '/beneficiaries', {
            corporate: { role: 'employee', permissions: permissionsForRole('employee'), companyId: 'c1' },
            headers: { accept: 'application/json' },
            originalUrl: '/api/corporate/beneficiaries',
            body: {}
        });
        expect(res.status).toHaveBeenCalledWith(403);
    });

    test('accountant hitting approve is 403', async () => {
        const res = await runRoute('post', '/requests/:id/approve', {
            corporate: { role: 'accountant', permissions: permissionsForRole('accountant'), companyId: 'c1' },
            headers: { accept: 'application/json' },
            originalUrl: '/api/corporate/requests/1/approve',
            params: { id: '1' },
            body: {}
        });
        expect(res.status).toHaveBeenCalledWith(403);
    });

    test('manager may call beneficiary create after role gate', async () => {
        CorporateBeneficiary.create.mockResolvedValue({
            _id: 'b1',
            name: 'Payee',
            serviceType: 'vodafone',
            accountNumberLast4: '5432',
            status: 'approved',
            toPublicJSON: () => ({ id: 'b1', name: 'Payee' })
        });
        const res = await runRoute('post', '/beneficiaries', {
            corporate: {
                role: 'manager',
                permissions: permissionsForRole('manager'),
                companyId: 'c1',
                actor: { _id: 'm1', name: 'مدير' },
                tenantId: undefined
            },
            headers: { accept: 'application/json' },
            originalUrl: '/api/corporate/beneficiaries',
            body: { name: 'Payee', accountNumber: '01098765432' },
            session: { csrfToken: 'x' }
        });
        expect(CorporateBeneficiary.create).toHaveBeenCalled();
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CORPORATE_BENEFICIARY_ADDED' }));
        expect(res.status).toHaveBeenCalledWith(201);
    });
});
