'use strict';
jest.mock('../models/Transaction', () => ({ findOne: jest.fn() }));
const Transaction = require('../models/Transaction');
const service = require('../services/retailOperationDetailsService');
test('direct and subordinate scopes include ownership and tenant boundaries', () => {
    expect(
        service.scope({
            actorModel: 'User',
            actor: { _id: 'owner', phone: '0911', webUsername: 'demo', tenantId: 'tenant' },
        })
    ).toEqual({
        userId: { $in: ['owner', '0911', 'demo'] },
        companyId: null,
        subAccountId: null,
        tenantId: 'tenant',
    });
    expect(service.scope({ actorModel: 'SubAccount', actor: { _id: 'child', tenantId: 'tenant' } })).toEqual({
        subAccountId: 'child',
        tenantId: 'tenant',
    });
});
test('presentation exposes customer cost and receipt proxies, never executor secrets', () => {
    const result = service.present(
        {
            _id: 'id',
            customId: 'REF',
            transferType: 'bank_account',
            amount: 500,
            costLYD: 10,
            subAccountCostLYD: 15,
            agencyPricing: { customerChargeLYD: 20, customerRate: 25 },
            executorProofImages: ['private.jpg'],
            proofImage: 'proofs/customer.jpg',
            apiToken: 'SECRET',
            apiResultData: { private: 'SECRET' },
        },
        'SubAccount'
    );
    expect(result.costLYD).toBe(20);
    expect(result.exchangeRate).toBe(25);
    expect(result.receipts).toEqual([
        { label: 'إثبات التحويل البنكي', url: '/client/api/retail-transactions/id/proof/0' },
    ]);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(JSON.stringify(result)).not.toContain('private.jpg');
    expect(JSON.stringify(result)).not.toContain('customer.jpg');
});
test('foreign and malformed transaction identifiers never yield a proof', async () => {
    const ctx = { actorModel: 'User', actor: { _id: 'owner', phone: '0911' } };
    await expect(service.findOwn(ctx, 'bad')).rejects.toMatchObject({ statusCode: 404 });
    expect(Transaction.findOne).not.toHaveBeenCalled();
    Transaction.findOne.mockReturnValue({ lean: async () => null });
    await expect(service.findOwn(ctx, '6ae5008e880226d4b241969d')).rejects.toMatchObject({ statusCode: 404 });
    expect(Transaction.findOne.mock.calls[0][0].$and[1]).toMatchObject({
        companyId: null,
        subAccountId: null,
        tenantId: null,
    });
});
