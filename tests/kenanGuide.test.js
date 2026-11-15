'use strict';
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));
const axios = require('axios');
const service = require('../services/kenanProviderService');
const base = { reference: '0000014', phone: '01000000000', amount_minor: 10000, status: 'success' };
const bot = { apiUrl: 'https://kenan.example', apiToken: 'fixture-key' };
beforeEach(() => { jest.clearAllMocks(); process.env.EXTERNAL_API_ENABLED = 'true'; });
test('preserves every documented receipt field including nullable legacy values', () => {
    const data = { ...base, executor_phone: '01100000000', completed_at: '2026-11-14T23:41:00Z', created_at: '2026-11-14T23:39:53Z', fee_minor: 100,
        balance_before_minor: 50000, deducted_minor: 10000, balance_after_minor: 40000, customer_service_phone: '+201108172258', reason: '' };
    expect(service.parseOrder(data)).toMatchObject(data);
    expect(service.parseOrder(base)).toMatchObject({ executor_phone: null, completed_at: null, balance_before_minor: null, deducted_minor: null, balance_after_minor: null });
});
test.each([{ executor_phone: 1100000000 }, { fee_minor: -1 }, { deducted_minor: 1.5 }, { completed_at: 'yesterday' }, { balance_before_minor: 300, deducted_minor: 100, balance_after_minor: 250 }])('rejects invalid receipt data %j', extra => {
    expect(() => service.parseOrder({ ...base, ...extra })).toThrow();
});
test('reads the latest orders and deposits without creating transfers', async () => {
    axios.get.mockResolvedValueOnce({ data: [base] }).mockResolvedValueOnce({ data: [{ reference: 'DEP-1', amount_minor: 10000, created_at: '2026-11-14T23:41:00Z', responsible: 'operator' }] });
    expect(await service.getLatestOrders(bot)).toMatchObject({ success: true, orders: [{ reference: '0000014' }] });
    expect(await service.getDeposits(bot)).toMatchObject({ success: true, deposits: [{ reference: 'DEP-1', amount_minor: 10000 }] });
    expect(axios.post).not.toHaveBeenCalled();
});
