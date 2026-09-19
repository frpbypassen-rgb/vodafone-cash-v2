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
    Model.findOneAndUpdate = jest.fn();
    Model.find = jest.fn(() => ({
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([])
    }));
    Model.create = jest.fn();
    Model.aggregate = jest.fn().mockResolvedValue([]);
    return Model;
});
jest.mock('../models/CorporateInvoice', () => ({ find: jest.fn(), create: jest.fn() }));
jest.mock('../models/Ledger', () => ({
    findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({
        transactionId: 'FOREIGN-LEDGER',
        entityId: 'other-company',
        amount: -999,
        balanceBefore: 1,
        balanceAfter: 0
    }) })),
    find: jest.fn(() => ({ sort: jest.fn().mockReturnThis(), limit: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) }))
}));
jest.mock('../models/AuditLog', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../models/Settings', () => ({
    findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue({ cashRateLevel1: 6.5, rateLevel1: 6.5 }) }))
}));
jest.mock('../services/auditService', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../services/transferService', () => ({
    createTransfer: jest.fn().mockResolvedValue({
        success: true,
        txId: 'ATT-2609-0099',
        costLYD: 100,
        exchangeRate: 6.5,
        newBalance: 8800
    })
}));
jest.mock('../utils/rateHelper', () => ({
    getCompanyServiceRates: jest.fn(() => ({
        vodafone: 6.5,
        post_account: 6.45,
        post_card: 6.35,
        bank_account: 6.4,
        sefa_niger: 0.002,
        bankak_sudan: 6.7
    }))
}));
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
const { quoteSettlement, payoutIdempotencyKey } = require('../services/corporateLedgerService');
const { createTransfer } = require('../services/transferService');
const { updateBalanceWithLedger } = require('../services/walletService');
const { requireCorporateStepUp } = require('../middlewares/corporateStepUp');
const CorporateBeneficiary = require('../models/CorporateBeneficiary');
const CorporatePaymentRequest = require('../models/CorporatePaymentRequest');
const { scopedFilter, MAX_LIST_LIMIT, EXPORT_LIMIT } = require('../services/corporateReportService');
const { detectCorporateView } = require('../middlewares/corporateAuth');
const corporateApi = require('../routes/corporateApi');
const ClientEmployee = require('../models/ClientEmployee');
const bcrypt = require('bcryptjs');

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
        company: { _id: 'comp-1', balance: 9000, creditLimit: 0, corporatePortal: {}, tier: 1 },
        profile: { defaultEmployeeApprovalLimit: 0 },
        role: 'manager',
        permissions: permissionsForRole('manager'),
        companyId: 'comp-1',
        tenantId: undefined
    };

    const stubRequest = (overrides = {}) => {
        const request = {
            _id: 'req-1',
            companyId: 'comp-1',
            status: 'pending_approval',
            requesterId: 'emp-1',
            beneficiaryId: 'ben-1',
            amount: 650,
            currency: 'EGP',
            reference: 'CORP-TEST-1',
            beneficiarySnapshot: { name: 'مورد', serviceType: 'vodafone' },
            payoutTransactionId: '',
            save: jest.fn().mockResolvedValue(true),
            ...overrides
        };
        request.save.mockImplementation(async () => request);
        return request;
    };

    beforeEach(() => {
        jest.clearAllMocks();
        createTransfer.mockResolvedValue({
            success: true,
            txId: 'ATT-2609-0099',
            costLYD: 100,
            exchangeRate: 6.5,
            newBalance: 8800
        });
        CorporateBeneficiary.findOne.mockImplementation(() => ({
            select: jest.fn().mockResolvedValue({
                _id: 'ben-1',
                name: 'مورد',
                serviceType: 'vodafone',
                accountNumberLast4: '5432',
                decryptAccountNumber: () => '01098765432'
            })
        }));
        CorporatePaymentRequest.findOneAndUpdate.mockImplementation(async (_filter, update) => {
            const request = stubRequest({ status: 'executing', ...update.$set });
            Object.assign(request, update.$set);
            return request;
        });
    });

    test('approve writes CORPORATE_TRANSFER_APPROVED and executes once', async () => {
        const request = stubRequest();
        CorporatePaymentRequest.findOne.mockResolvedValue(request);
        CorporatePaymentRequest.findOneAndUpdate.mockImplementation(async (_filter, update) => {
            Object.assign(request, update.$set);
            return request;
        });
        const result = await approvalService.decideRequest({
            context,
            requestId: 'req-1',
            decision: 'approve',
            req: { headers: {}, method: 'POST', originalUrl: '/api/corporate/requests/req-1/approve' }
        });
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CORPORATE_TRANSFER_APPROVED' }));
        expect(createTransfer).toHaveBeenCalled();
        expect(result.request.status).toBe('executed');
        expect(result.request.payoutTransactionId).toBe('ATT-2609-0099');
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

    test('manager create-transfer without step-up proof is 403', async () => {
        const res = await runRoute('post', '/requests', {
            corporate: {
                role: 'manager',
                permissions: permissionsForRole('manager'),
                companyId: 'c1',
                actor: { _id: 'm1', name: 'مدير' }
            },
            headers: { accept: 'application/json' },
            originalUrl: '/api/corporate/requests',
            body: { beneficiaryId: 'b1', amount: 100 },
            session: {}
        });
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'STEP_UP_REQUIRED' }));
    });

    test('manager approve without step-up proof is 403', async () => {
        const res = await runRoute('post', '/requests/:id/approve', {
            corporate: {
                role: 'manager',
                permissions: permissionsForRole('manager'),
                companyId: 'c1',
                actor: { _id: 'm1', name: 'مدير' }
            },
            headers: { accept: 'application/json' },
            originalUrl: '/api/corporate/requests/1/approve',
            params: { id: '1' },
            body: {},
            session: {}
        });
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'STEP_UP_REQUIRED' }));
    });
});

describe('FX quote and payout execution', () => {
    const context = {
        actor: { _id: 'mgr-1', name: 'مدير' },
        company: { _id: 'comp-1', balance: 9000, creditLimit: 0, corporatePortal: {}, tier: 1 },
        profile: {},
        role: 'manager',
        permissions: permissionsForRole('manager'),
        companyId: 'comp-1'
    };

    const makeRequest = (overrides = {}) => {
        const request = {
            _id: 'req-fx',
            companyId: 'comp-1',
            status: 'pending_approval',
            requesterId: 'emp-1',
            beneficiaryId: 'ben-1',
            amount: 650,
            currency: 'EGP',
            reference: 'CLIENT-FORGED-REF',
            beneficiarySnapshot: { name: 'مورد', serviceType: 'vodafone' },
            payoutTransactionId: '',
            save: jest.fn()
        };
        Object.assign(request, overrides);
        request.save.mockImplementation(async () => request);
        return request;
    };

    beforeEach(() => {
        jest.clearAllMocks();
        createTransfer.mockResolvedValue({
            success: true,
            txId: 'ATT-2609-0100',
            costLYD: 100,
            exchangeRate: 6.5,
            newBalance: 8900
        });
        CorporateBeneficiary.findOne.mockImplementation(() => ({
            select: jest.fn().mockResolvedValue({
                _id: 'ben-1',
                name: 'مورد',
                serviceType: 'vodafone',
                decryptAccountNumber: () => '01098765432'
            })
        }));
    });

    test('EGP request quotes the correct LYD debit at the company rate', async () => {
        const quote = await quoteSettlement({
            company: context.company,
            amount: 650,
            currency: 'EGP',
            serviceType: 'vodafone'
        });
        expect(quote.originalAmount).toBe(650);
        expect(quote.originalCurrency).toBe('EGP');
        expect(quote.exchangeRate).toBe(6.5);
        expect(quote.settledAmount).toBe(100);
        expect(quote.settledCurrency).toBe('LYD');
    });

    test('execution creates a transfer/payout artifact linked to the request', async () => {
        const request = makeRequest();
        CorporatePaymentRequest.findOne.mockResolvedValue(request);
        CorporatePaymentRequest.findOneAndUpdate.mockImplementation(async (_filter, update) => {
            Object.assign(request, update.$set);
            return request;
        });
        const result = await approvalService.decideRequest({
            context,
            requestId: request._id,
            decision: 'approve',
            req: { headers: {}, originalUrl: '/api/corporate/requests/req-fx/approve' }
        });
        expect(createTransfer).toHaveBeenCalledWith(expect.objectContaining({
            userId: 'mgr-1',
            accountType: 'company',
            transferData: expect.objectContaining({
                amount: 650,
                number: '01098765432',
                transferType: 'vodafone',
                currency: 'EGP'
            }),
            req: expect.objectContaining({
                headers: expect.objectContaining({
                    'idempotency-key': payoutIdempotencyKey('comp-1', 'req-fx')
                })
            })
        }));
        expect(result.request.status).toBe('executed');
        expect(result.request.payoutTransactionId).toBe('ATT-2609-0100');
        expect(result.request.ledgerTransactionId).toBe('ATT-2609-0100');
        expect(result.request.settledAmount).toBe(100);
        expect(result.request.settledCurrency).toBe('LYD');
        expect(result.request.exchangeRate).toBe(6.5);
        expect(updateBalanceWithLedger).not.toHaveBeenCalled();
    });

    test('a foreign/global ledger reference does not mark this company request executed', async () => {
        const request = makeRequest({ reference: 'FOREIGN-LEDGER' });
        CorporatePaymentRequest.findOne.mockResolvedValue(request);
        CorporatePaymentRequest.findOneAndUpdate.mockImplementation(async (_filter, update) => {
            Object.assign(request, update.$set);
            return request;
        });
        const result = await approvalService.executeRequest({
            context,
            request,
            req: { headers: {} }
        });
        expect(createTransfer).toHaveBeenCalledTimes(1);
        expect(result.request.status).toBe('executed');
        expect(result.request.payoutTransactionId).toBe('ATT-2609-0100');
        expect(result.request.payoutTransactionId).not.toBe('FOREIGN-LEDGER');
    });

    test('debit failure leaves execution_failed and a retry completes without a second raw debit', async () => {
        const request = makeRequest({ status: 'pending_approval' });
        CorporatePaymentRequest.findOne.mockResolvedValue(request);
        CorporatePaymentRequest.findOneAndUpdate.mockImplementation(async (_filter, update) => {
            Object.assign(request, update.$set);
            return request;
        });
        createTransfer
            .mockResolvedValueOnce({
                success: false,
                statusCode: 400,
                code: 'INSUFFICIENT_BALANCE',
                message: 'رصيد غير كافٍ'
            })
            .mockResolvedValueOnce({
                success: true,
                code: 'DUPLICATE_REPLAYED',
                txId: 'ATT-2609-0100',
                costLYD: 100,
                exchangeRate: 6.5,
                newBalance: 8900
            });

        await expect(approvalService.decideRequest({
            context,
            requestId: request._id,
            decision: 'approve',
            req: { headers: {} }
        })).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
        expect(request.status).toBe('execution_failed');
        expect(request.payoutTransactionId).toBeFalsy();

        request.status = 'execution_failed';
        const retried = await approvalService.executeRequest({
            context,
            request,
            req: { headers: {} }
        });
        expect(retried.request.status).toBe('executed');
        expect(retried.idempotent).toBe(true);
        expect(createTransfer).toHaveBeenCalledTimes(2);
        const keys = createTransfer.mock.calls.map((call) => call[0].req.headers['idempotency-key']);
        expect(keys[0]).toBe(keys[1]);
        expect(keys[0]).toBe(payoutIdempotencyKey('comp-1', 'req-fx'));
        expect(updateBalanceWithLedger).not.toHaveBeenCalled();
    });
});

describe('corporate step-up middleware', () => {
    test('rejects missing proof', async () => {
        const req = {
            corporate: { actor: { _id: 'm1' } },
            body: { amount: 10 },
            headers: {},
            session: {}
        };
        const res = jsonRes();
        await requireCorporateStepUp(req, res, () => {
            throw new Error('should not pass');
        });
        expect(res.status).toHaveBeenCalledWith(403);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'STEP_UP_REQUIRED' }));
    });

    test('accepts a verified password on the same request', async () => {
        const password = 'CorpDemo!234';
        const hash = await bcrypt.hash(password, 4);
        ClientEmployee.findById.mockResolvedValue({ _id: 'm1', webPassword: hash });
        const req = {
            corporate: { actor: { _id: 'm1' } },
            body: { password },
            headers: {},
            session: {}
        };
        const res = jsonRes();
        const next = jest.fn();
        await requireCorporateStepUp(req, res, next);
        expect(next).toHaveBeenCalled();
    });
});

describe('CSV export limits', () => {
    test('list and export caps are aligned at 500', () => {
        expect(MAX_LIST_LIMIT).toBe(500);
        expect(EXPORT_LIMIT).toBe(500);
    });
});

