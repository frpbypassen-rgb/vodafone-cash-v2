'use strict';

jest.mock('../services/businessPortalService', () => ({
    resolveWorkspace: jest.fn()
}));

jest.mock('../models/SubAccount', () => ({
    findOne: jest.fn()
}));

jest.mock('../services/auditService', () => ({
    logAction: jest.fn().mockResolvedValue(undefined)
}));

const businessPortalService = require('../services/businessPortalService');
const SubAccount = require('../models/SubAccount');
const { logAction } = require('../services/auditService');
const controller = require('../controllers/clientWorkspaceController');

const workspace = {
    isAgent: true,
    type: 'agent',
    masterType: 'user',
    masterId: 'agent-123',
    actor: { _id: 'agent-123', name: 'وكالة الاختبار' },
    actorModel: 'User',
    permissions: { canManageCustomers: true }
};

const createResponse = () => ({
    redirect: jest.fn()
});

describe('Agent customer credit-limit workspace flow', () => {
    let consoleErrorSpy;

    beforeEach(() => {
        jest.clearAllMocks();
        consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        businessPortalService.resolveWorkspace.mockResolvedValue(workspace);
    });

    afterEach(() => {
        consoleErrorSpy.mockRestore();
    });

    it('saves a positive debt limit for an owned customer and writes an audit event', async () => {
        const customer = {
            _id: 'customer-123',
            balance: 0,
            creditLimit: 0,
            save: jest.fn().mockResolvedValue(undefined)
        };
        const io = { emit: jest.fn() };
        const req = {
            params: { id: customer._id },
            body: { creditLimit: '1000', returnTo: 'profile' },
            app: { get: jest.fn().mockReturnValue(io) }
        };
        const res = createResponse();
        SubAccount.findOne.mockResolvedValue(customer);

        await controller.postUpdateCustomerCreditLimit(req, res);

        expect(SubAccount.findOne).toHaveBeenCalledWith({
            _id: customer._id,
            masterType: 'user',
            masterId: 'agent-123',
            status: { $ne: 'deleted' }
        });
        expect(customer.creditLimit).toBe(1000);
        expect(customer.creditLimitUpdatedBy).toBe('وكالة الاختبار');
        expect(customer.creditLimitUpdatedByModel).toBe('User');
        expect(customer.save).toHaveBeenCalledTimes(1);
        expect(logAction).toHaveBeenCalledWith(expect.objectContaining({
            action: 'SUB_ACCOUNT_CREDIT_LIMIT_UPDATED',
            oldData: { creditLimit: 0 },
            newData: { creditLimit: 1000, minimumBalance: -1000 }
        }));
        expect(io.emit).toHaveBeenCalledWith('update_data');
        expect(res.redirect).toHaveBeenCalledWith('/client/customers/customer-123?customerSuccess=credit_limit');
    });

    it('refuses to lower the debt limit below the customer debt', async () => {
        const customer = {
            _id: 'customer-123',
            balance: -100,
            creditLimit: 1000,
            save: jest.fn()
        };
        const req = {
            params: { id: customer._id },
            body: { creditLimit: '99', returnTo: 'profile' },
            app: { get: jest.fn() }
        };
        const res = createResponse();
        SubAccount.findOne.mockResolvedValue(customer);

        await controller.postUpdateCustomerCreditLimit(req, res);

        expect(customer.creditLimit).toBe(1000);
        expect(customer.save).not.toHaveBeenCalled();
        expect(logAction).not.toHaveBeenCalled();
        expect(res.redirect).toHaveBeenCalledWith('/client/customers/customer-123?customerError=limit_below_debt');
    });
});
