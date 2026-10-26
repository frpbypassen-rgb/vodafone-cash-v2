jest.mock('../services/businessPortalService', () => ({ resolveWorkspace: jest.fn() }));
jest.mock('../models/SubAccount', () => ({ create: jest.fn() }));
jest.mock('../services/accountCodeService', () => ({ assignGeneratedAccountCode: jest.fn(), CODE_LENGTHS: { subAccount: 6 } }));
jest.mock('../services/auditService', () => ({ logAction: jest.fn() }));
jest.mock('../controllers/portalWorkspace/common', () => ({
    cleanText: value => String(value || '').trim(),
    normalizeUsername: value => String(value) + '@ahram.com',
    assertIdentityAvailable: jest.fn(),
    requireCustomerManager: jest.fn(),
    redirectWithMessage: (res, path, type, code) => res.redirect(`${path}?${type}=${code}`)
}));
jest.mock('../services/agencyCreditLimitService', () => ({ normalizeCreditLimit: value => Number(value || 0) }));
const { postCreateCustomer } = require('../controllers/portalWorkspace/customersController');
const portal = require('../services/businessPortalService');
const SubAccount = require('../models/SubAccount');
const common = require('../controllers/portalWorkspace/common');
const workspace = { masterType: 'user', masterId: 'agency-a', type: 'agent', actor: { name: 'Manager', _id: 'actor-a' }, actorModel: 'User' };
let req, res;
beforeEach(() => {
    jest.clearAllMocks();
    portal.resolveWorkspace.mockResolvedValue(workspace);
    SubAccount.create.mockResolvedValue({ _id: 'new-customer' });
    common.requireCustomerManager.mockImplementation(() => {});
    common.assertIdentityAvailable.mockResolvedValue(undefined);
    req = { baseUrl: '/agent-portal', headers: { accept: 'application/json' }, body: { name: 'Test Customer', phone: '0912345678', webUsername: 'test_customer', webPassword: 'Test-Only-Password1', marginPiasters: '0', creditLimit: '0' } };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn(), redirect: jest.fn() };
});
test('agent async creation returns success after creating an owned customer', async () => {
    await postCreateCustomer(req, res);
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ success: true, code: 'created' });
    expect(SubAccount.create).toHaveBeenCalledWith(expect.objectContaining({ masterId: 'agency-a', masterType: 'user', status: 'active' }));
    expect(res.redirect).not.toHaveBeenCalled();
});
test('duplicate identity returns a recoverable error without creating a customer', async () => {
    common.assertIdentityAvailable.mockRejectedValue(new Error('IDENTITY_TAKEN'));
    await postCreateCustomer(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ success: false, code: 'duplicate' });
    expect(SubAccount.create).not.toHaveBeenCalled();
});
test('invalid phone is rejected before creating a customer', async () => {
    req.body.phone = '123';
    await postCreateCustomer(req, res);
    expect(res.json).toHaveBeenCalledWith({ success: false, code: 'invalid' });
    expect(SubAccount.create).not.toHaveBeenCalled();
});
test('manager permission is still required for async requests', async () => {
    common.requireCustomerManager.mockImplementation(() => { throw new Error('FORBIDDEN'); });
    await postCreateCustomer(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(SubAccount.create).not.toHaveBeenCalled();
});
test('company forms preserve their existing redirect response', async () => {
    req.baseUrl = '/client';
    await postCreateCustomer(req, res);
    expect(res.redirect).toHaveBeenCalledWith('/client/customers?customerSuccess=created');
    expect(res.json).not.toHaveBeenCalled();
});
