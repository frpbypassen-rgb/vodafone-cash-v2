'use strict';
jest.mock('../models/Transaction', () => ({ findById: jest.fn() }));
jest.mock('../models/ExecutorGroup', () => ({ findById: jest.fn() }));
jest.mock('../models/Ledger', () => ({ countDocuments: jest.fn() }));
jest.mock('../services/kenanProviderService', () => ({ getTransactions: jest.fn() }));
jest.mock('../services/apiExecutionLifecycleService', () => ({ completeApiTransactionWithReference: jest.fn() }));
jest.mock('../services/auditService', () => ({ logAction: jest.fn() }));
jest.mock('../services/eventBus', () => ({ publish: jest.fn() }));
const Transaction = require('../models/Transaction'), Group = require('../models/ExecutorGroup'), Ledger = require('../models/Ledger');
const provider = require('../services/kenanProviderService'), lifecycle = require('../services/apiExecutionLifecycleService');
const { reconcileKenanOrder } = require('../services/kenanReconciliationService');
const input = { transactionId: 'tx', executorGroupId: 'group', actor: { id: 'admin', role: 'master' } };
const version = new Date('2026-11-15T00:00:00Z');
beforeEach(() => {
    jest.clearAllMocks();
    Transaction.findById.mockResolvedValue({ _id: 'tx', executorGroupId: 'group', customId: 'ATT-FIXTURE', amount: 100, status: 'processing', updatedAt: version, vodafoneNumber: '01000000000', apiResultData: { kenanReference: '0000014' } });
    Group.findById.mockResolvedValue({ _id: 'group', isApiBot: true, apiProviderKey: 'kenan', balance: 200 });
    Ledger.countDocuments.mockResolvedValue(0);
    provider.getTransactions.mockResolvedValue({ operations: [{ success: true, providerTransactionId: '0000014', phone: '01000000000', amount: 100, rawData: { reference: '0000014', status: 'success' } }] });
    lifecycle.completeApiTransactionWithReference.mockResolvedValue({ completed: true });
});
test('preview checks authoritative GET and performs no financial action while schedulers remain off', async () => {
    process.env.FINANCIAL_SCHEDULERS_ENABLED = 'false';
    expect(await reconcileKenanOrder(input)).toMatchObject({ eligible: true, applied: false, executorDebit: 100 });
    expect(lifecycle.completeApiTransactionWithReference).not.toHaveBeenCalled();
    expect(process.env.FINANCIAL_SCHEDULERS_ENABLED).toBe('false');
});
test.each(['assigned', 'executing', 'review', 'failed', 'cancelled'])('%s cannot complete a transaction', async status => {
    provider.getTransactions.mockResolvedValue({ operations: [{ success: true, providerTransactionId: '0000014', phone: '01000000000', amount: 100, rawData: { reference: '0000014', status } }] });
    await expect(reconcileKenanOrder({ ...input, confirm: true, expectedUpdatedAt: version })).rejects.toThrow('KENAN_SUCCESS_OR_BALANCE_REQUIRED');
    expect(lifecycle.completeApiTransactionWithReference).not.toHaveBeenCalled();
});
test.each([{ phone: '01111111111' }, { amount: 200 }, { providerTransactionId: '0000015' }, { success: false }])('mismatch or unavailable evidence %j cannot complete', async extra => {
    provider.getTransactions.mockResolvedValue({ operations: [{ success: true, providerTransactionId: '0000014', phone: '01000000000', amount: 100, ...extra }] });
    await expect(reconcileKenanOrder({ ...input, confirm: true, expectedUpdatedAt: version })).rejects.toThrow('KENAN_AUTHORITATIVE_RESULT_UNAVAILABLE');
    expect(lifecycle.completeApiTransactionWithReference).not.toHaveBeenCalled();
});
test('stale preview cannot write, and a fresh preview passes the row version into the atomic completion', async () => {
    await expect(reconcileKenanOrder({ ...input, confirm: true, expectedUpdatedAt: new Date(0) })).rejects.toThrow('KENAN_ROW_CHANGED');
    await reconcileKenanOrder({ ...input, confirm: true, expectedUpdatedAt: version });
    expect(lifecycle.completeApiTransactionWithReference).toHaveBeenCalledWith(expect.objectContaining({ verifiedKenan: { order: { reference: '0000014', status: 'success' }, expectedUpdatedAt: version } }));
});
test('prepaid account cannot be silently converted to credit', async () => {
    Group.findById.mockResolvedValue({ _id: 'group', isApiBot: true, apiProviderKey: 'kenan', balance: 0, apiSettlementMode: 'prepaid' });
    expect(await reconcileKenanOrder(input)).toMatchObject({ eligible: false });
    expect(lifecycle.completeApiTransactionWithReference).not.toHaveBeenCalled();
});

test.each([0, 2])('completed status with %i debits requires accounting review', async count => {
    const tx = await Transaction.findById();
    Transaction.findById.mockResolvedValue({ ...tx, status: 'completed' });
    Ledger.countDocuments.mockResolvedValue(count);
    await expect(reconcileKenanOrder(input)).rejects.toThrow('KENAN_LEDGER_CONFLICT');
    expect(lifecycle.completeApiTransactionWithReference).not.toHaveBeenCalled();
    expect(provider.getTransactions).not.toHaveBeenCalled();
});

test('completed status with exactly one matching debit is idempotent', async () => {
    const tx = await Transaction.findById();
    Transaction.findById.mockResolvedValue({ ...tx, status: 'completed' });
    Ledger.countDocuments.mockResolvedValue(1);
    expect(await reconcileKenanOrder(input)).toMatchObject({ idempotent: true, applied: false });
    expect(lifecycle.completeApiTransactionWithReference).not.toHaveBeenCalled();
});
