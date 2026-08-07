'use strict';

jest.mock('../models/Transaction', () => ({
    findById: jest.fn()
}));

jest.mock('../models/ExecutorGroup', () => ({
    findById: jest.fn()
}));

jest.mock('../services/externalApiService', () => ({
    executeTransferViaApi: jest.fn(),
    saveApiReceiptProof: jest.fn()
}));

jest.mock('../services/apiProviderReconciliationService', () => ({
    startApiBalanceAudit: jest.fn(),
    finishApiBalanceAudit: jest.fn(),
    withApiExecutorSerialization: jest.fn((executorGroupId, task) => task())
}));

jest.mock('../services/walletService', () => ({
    updateBalanceWithLedger: jest.fn()
}));

jest.mock('../services/eventBus', () => ({
    publish: jest.fn()
}));

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    financial: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const { executeTransferViaApi, saveApiReceiptProof } = require('../services/externalApiService');
const {
    startApiBalanceAudit,
    finishApiBalanceAudit,
    withApiExecutorSerialization
} = require('../services/apiProviderReconciliationService');
const { updateBalanceWithLedger } = require('../services/walletService');
const eventBus = require('../services/eventBus');
const queueService = require('../services/queueService');

describe('queueService API execution', () => {
    beforeEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
        startApiBalanceAudit.mockResolvedValue({
            _id: 'audit-1',
            beforeCheck: { availableBalance: 1000 },
            afterCheck: {},
            checkStatus: 'pending'
        });
        finishApiBalanceAudit.mockResolvedValue({
            _id: 'audit-1',
            beforeCheck: { availableBalance: 1000 },
            afterCheck: { availableBalance: 900 },
            expectedDebit: 100,
            observedDebit: 100,
            debitDifference: 0,
            checkStatus: 'matched'
        });
    });

    test('completes API transaction immediately when provider reference is received', async () => {
        const tx = {
            _id: 'tx-1',
            customId: 'ATT-2608-0001',
            status: 'processing',
            amount: 100,
            notes: '',
            adminNotes: '',
            save: jest.fn().mockResolvedValue(true),
            set: jest.fn()
        };
        const executorGroup = {
            _id: 'group-api',
            name: 'Zayn API'
        };

        Transaction.findById.mockResolvedValue(tx);
        ExecutorGroup.findById.mockResolvedValue(executorGroup);
        executeTransferViaApi.mockResolvedValue({
            success: true,
            reference_number: '28059087',
            sender_number: '28059087',
            external_transaction_id: '50011611',
            processLog: 'PAYMENT_SUCCESS'
        });
        saveApiReceiptProof.mockResolvedValue('proofs/ATT-2608-0001_api.jpg');
        updateBalanceWithLedger.mockResolvedValue({ success: true });

        await queueService.processSingleJob('tx-1', 'group-api');

        expect(withApiExecutorSerialization).toHaveBeenCalledWith('group-api', expect.any(Function));
        expect(startApiBalanceAudit).toHaveBeenCalledWith({ tx, executorGroup });
        expect(finishApiBalanceAudit).toHaveBeenCalledWith({
            audit: expect.objectContaining({ _id: 'audit-1' }),
            tx,
            executorGroup,
            apiResult: expect.objectContaining({ external_transaction_id: '50011611' })
        });
        expect(tx.status).toBe('completed');
        expect(tx.executorName).toBe('تنفيذ آلي (API)');
        expect(tx.executorSenderPhone).toBe('28059087');
        expect(tx.proofImage).toBe('proofs/ATT-2608-0001_api.jpg');
        expect(tx.proofImages).toEqual(['proofs/ATT-2608-0001_api.jpg']);
        expect(tx.notes).toContain('[الرقم المرجعي: 28059087]');
        expect(tx.notes).toContain('[رقم عملية المزود: 50011611]');
        expect(tx.apiResultData).toMatchObject({
            waitingApiAutoCompletion: false,
            autoCompleteAt: null,
            referenceNumber: '28059087',
            completionMode: 'immediate_reference',
            ledgerPosted: true
        });
        expect(updateBalanceWithLedger).toHaveBeenCalledWith(
            'ExecutorGroup',
            'group-api',
            -100,
            'TRANSFER',
            'ATT-2608-0001',
            'تنفيذ API آلي'
        );
        expect(tx.save).toHaveBeenCalled();
        expect(eventBus.publish).toHaveBeenCalledWith('transfer:completed', {
            tx,
            emp: { name: 'Zayn API' }
        });
    });

    test('continues API completion when balance reconciliation reports a discrepancy', async () => {
        const tx = {
            _id: 'tx-2',
            customId: 'ATT-2608-0002',
            status: 'processing',
            amount: 50,
            notes: '',
            adminNotes: '',
            save: jest.fn().mockResolvedValue(true),
            set: jest.fn()
        };
        const executorGroup = { _id: 'group-api', name: 'Zayn API' };
        Transaction.findById.mockResolvedValue(tx);
        ExecutorGroup.findById.mockResolvedValue(executorGroup);
        executeTransferViaApi.mockResolvedValue({
            success: true,
            reference_number: 'REF-2',
            external_transaction_id: 'PROVIDER-2',
            processLog: 'PAYMENT_SUCCESS'
        });
        finishApiBalanceAudit.mockResolvedValue({
            _id: 'audit-2',
            beforeCheck: { availableBalance: 900 },
            afterCheck: { availableBalance: 830 },
            expectedDebit: 50,
            observedDebit: 70,
            debitDifference: 20,
            checkStatus: 'discrepancy'
        });
        saveApiReceiptProof.mockResolvedValue('proofs/ATT-2608-0002_api.jpg');
        updateBalanceWithLedger.mockResolvedValue({ success: true });

        await queueService.processSingleJob('tx-2', 'group-api');

        expect(tx.status).toBe('completed');
        expect(tx.adminNotes).toContain('الحالة: discrepancy');
        expect(eventBus.publish).toHaveBeenCalledWith('transfer:completed', expect.objectContaining({ tx }));
    });

    test('returns a mismatched API task to administration without calling the provider', async () => {
        const tx = {
            _id: 'tx-postal',
            customId: 'ATT-2608-POST',
            status: 'processing',
            transferType: 'post_account',
            adminNotes: '',
            save: jest.fn().mockResolvedValue(true)
        };
        const executorGroup = {
            _id: 'cash-api',
            name: 'Cash API',
            serviceKey: 'vodafone'
        };
        Transaction.findById.mockResolvedValue(tx);
        ExecutorGroup.findById.mockResolvedValue(executorGroup);

        await queueService.processSingleJob('tx-postal', 'cash-api');

        expect(tx.status).toBe('pending');
        expect(tx.executorGroupId).toBeUndefined();
        expect(tx.adminNotes).toContain('لا تطابق خدمة المنفذ');
        expect(executeTransferViaApi).not.toHaveBeenCalled();
        expect(startApiBalanceAudit).not.toHaveBeenCalled();
    });
});
