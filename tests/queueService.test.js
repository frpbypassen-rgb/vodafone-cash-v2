'use strict';

jest.mock('../models/Transaction', () => ({
    findById: jest.fn()
}));

jest.mock('../models/ExecutorGroup', () => ({
    findById: jest.fn()
}));

jest.mock('../models/ClientCompany', () => ({}));
jest.mock('../models/ClientEmployee', () => ({}));
jest.mock('../models/Admin', () => ({}));
jest.mock('../models/Employee', () => ({}));

jest.mock('../services/externalApiService', () => ({
    executeTransferViaApi: jest.fn(),
    saveApiReceiptProof: jest.fn()
}));

jest.mock('../services/walletService', () => ({
    updateBalanceWithLedger: jest.fn()
}));

jest.mock('../utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
}));

const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const { executeTransferViaApi, saveApiReceiptProof } = require('../services/externalApiService');
const { updateBalanceWithLedger } = require('../services/walletService');
const queueService = require('../services/queueService');

describe('queueService API execution', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('completes API transaction when provider returns a normal reference number and saves receipt proof', async () => {
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

        expect(tx.status).toBe('completed');
        expect(tx.executorName).toBe('تنفيذ آلي (API)');
        expect(tx.executorSenderPhone).toBe('28059087');
        expect(tx.proofImage).toBe('proofs/ATT-2608-0001_api.jpg');
        expect(tx.proofImages).toEqual(['proofs/ATT-2608-0001_api.jpg']);
        expect(tx.notes).toContain('[الرقم المرجعي: 28059087]');
        expect(tx.notes).toContain('[رقم عملية المزود: 50011611]');
        expect(updateBalanceWithLedger).toHaveBeenCalledWith('ExecutorGroup', 'group-api', -100, 'TRANSFER', 'ATT-2608-0001', 'تنفيذ API آلي');
        expect(tx.save).toHaveBeenCalled();
    });
});
