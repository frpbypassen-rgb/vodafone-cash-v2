'use strict';
jest.mock('../services/clientHubContextService', () => ({ buildHubRenderContext: jest.fn() }));
jest.mock('../models/Transaction', () => ({ find: jest.fn(), exists: jest.fn() }));
jest.mock('../controllers/clientWorkspaceController', () => ({
    renderPage: jest.fn(() => jest.fn()),
    parseSmartTransferMessage: jest.fn(),
}));
const { buildHubRenderContext } = require('../services/clientHubContextService');
const Transaction = require('../models/Transaction');
const retail = require('../controllers/retailTransferController');
const ctx = (type = 'user', role = 'user') => ({
    accountType: type,
    isSubAccount: type === 'sub_client',
    account: { _id: 'retail-id', name: 'أحمد', phone: '0911111111', role },
    user: { name: 'أحمد', balance: 2500 },
    serviceRates: {
        vodafone: 10,
        post_account: 9.95,
        post_card: 9.85,
        bank_account: 9.9,
        sefa_niger: 0.01,
        bankak_sudan: 250,
    },
    csrfToken: 'test',
});
const response = () => ({
    render: jest.fn(),
    redirect: jest.fn(),
    status: jest.fn().mockReturnThis(),
    send: jest.fn(),
    json: jest.fn(),
});
beforeEach(() => {
    jest.clearAllMocks();
    Transaction.find.mockReturnValue({
        select: () => ({ sort: () => ({ limit: () => ({ lean: async () => [] }) }) }),
    });
    buildHubRenderContext.mockResolvedValue(ctx());
});
test('retail gallery uses the canonical six services and customer-specific prices', async () => {
    const res = response();
    await retail.renderPage('services')({ query: {}, params: {} }, res);
    const data = res.render.mock.calls[0][1];
    expect(data.serviceCatalog).toHaveLength(6);
    expect(data.serviceCatalog.find((s) => s.key === 'sefa_niger')).toMatchObject({
        rate: 0.01,
        rateDirection: 'source_to_lyd',
    });
    expect(data.workspace).toMatchObject({ isCompany: false, isAgent: false, type: 'customer' });
});
test('recent operations stay scoped to the signed-in customer', async () => {
    await retail.renderPage('service_workbench')({ params: { serviceKey: 'cash' }, query: {} }, response());
    expect(Transaction.find.mock.calls[0][0]).toMatchObject({
        userId: '0911111111',
        companyId: null,
        subAccountId: null,
        transferType: 'vodafone',
    });
});
test('sub-client operations are never queried by the master phone', async () => {
    buildHubRenderContext.mockResolvedValue(ctx('sub_client'));
    await retail.renderPage('service_workbench')(
        { params: { serviceKey: 'post-card' }, query: {} },
        response()
    );
    expect(Transaction.find.mock.calls[0][0]).toMatchObject({ subAccountId: 'retail-id' });
    expect(Transaction.find.mock.calls[0][0]).not.toHaveProperty('userId');
});
test('unknown services and read-only accounts cannot open an entry form', async () => {
    const res = response();
    await retail.renderPage('service_workbench')({ params: { serviceKey: 'missing' }, query: {} }, res);
    expect(res.status).toHaveBeenCalledWith(404);
    buildHubRenderContext.mockResolvedValue(ctx('user', 'accountant'));
    const denied = response();
    await retail.renderPage('service_workbench')({ params: { serviceKey: 'cash' }, query: {} }, denied);
    expect(denied.status).toHaveBeenCalledWith(403);
});
test('company requests keep their existing renderer', async () => {
    buildHubRenderContext.mockResolvedValue(null);
    const original = require('../controllers/clientWorkspaceController');
    const handler = jest.fn();
    original.renderPage.mockReturnValue(handler);
    const req = {},
        res = response();
    await retail.renderPage('service_workbench')(req, res);
    expect(original.renderPage).toHaveBeenCalledWith('service_workbench');
    expect(handler).toHaveBeenCalledWith(req, res, undefined);
});
test('message duplicate checks are scoped to this customer and never mutate money', async () => {
    Transaction.exists.mockResolvedValue(null);
    const res = response();
    await retail.parseMessage({ body: { message: 'حول 1500 جنيه على 01012345678' } }, res);
    expect(Transaction.exists).toHaveBeenCalledTimes(2);
    Transaction.exists.mock.calls.forEach(([filter]) =>
        expect(filter).toMatchObject({ userId: '0911111111', companyId: null, subAccountId: null })
    );
    expect(res.json.mock.calls[0][0]).toMatchObject({
        success: true,
        parsed: { duplicateCheck: { detected: false } },
    });
});
test('read-only accounts cannot analyze a transfer message', async () => {
    buildHubRenderContext.mockResolvedValue(ctx('user', 'accountant'));
    const res = response();
    await retail.parseMessage({ body: { message: 'حول 1500 جنيه على 01012345678' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(Transaction.exists).not.toHaveBeenCalled();
});
