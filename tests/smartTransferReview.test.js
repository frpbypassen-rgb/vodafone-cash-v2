'use strict';

jest.mock('../models/Transaction', () => ({ exists: jest.fn() }));
const Transaction = require('../models/Transaction');
const { findCompanyDuplicate } = require('../services/smartTransferReviewService');

describe('company smart transfer duplicate warning', () => {
    const workspace = { isCompany: true, entity: { _id: 'company-a' }, permissions: { canTransfer: true, employee: true } };
    const parsed = { ready: true, phone: '01012345678', amountEGP: 1600, serviceKey: 'vodafone' };
    beforeEach(() => jest.resetAllMocks());

    test.each([[true, false], [false, true], [true, true], [false, false]])('reports pending=%s and completed=%s without exposing records', async (pending, completed) => {
        Transaction.exists.mockResolvedValueOnce(pending ? { _id: 'private-record' } : null)
            .mockResolvedValueOnce(completed ? { _id: 'private-record-2' } : null);
        const now = new Date('2026-10-22T10:00:00Z');
        expect(await findCompanyDuplicate(workspace, parsed, now)).toEqual({
            detected: pending || completed, pending, completed, windowHours: 24
        });
        const filters = Transaction.exists.mock.calls.map(([filter]) => filter);
        for (const filter of filters) {
            expect(filter).toMatchObject({ companyId: 'company-a', transferType: 'vodafone', vodafoneNumber: parsed.phone,
                amount: 1600, createdAt: { $gte: new Date('2026-10-21T10:00:00Z'), $lte: now } });
        }
        expect(filters[0].status).toEqual({ $in: ['pending', 'processing', 'accepted'] });
        expect(filters[1].status).toBe('completed');
    });
    test('does not query other companies, unauthorized accounts or ambiguous/unsupported drafts', async () => {
        for (const [account, draft] of [
            [{ ...workspace, isCompany: false }, parsed],
            [{ ...workspace, entity: {} }, parsed],
            [{ ...workspace, permissions: { canTransfer: false } }, parsed],
            [workspace, { ...parsed, ready: false }],
            [workspace, { ...parsed, serviceKey: 'bank_account' }]
        ]) expect(await findCompanyDuplicate(account, draft)).toBeNull();
        expect(Transaction.exists).not.toHaveBeenCalled();
    });
    test('fails rather than reporting no duplicates when the database check fails', async () => {
        Transaction.exists.mockRejectedValue(new Error('database unavailable'));
        await expect(findCompanyDuplicate(workspace, parsed)).rejects.toThrow('database unavailable');
    });
});
