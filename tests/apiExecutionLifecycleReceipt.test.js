'use strict';

jest.mock('../models/Transaction', () => ({ findById: jest.fn() }));
jest.mock('../models/ExecutorGroup', () => ({ findById: jest.fn() }));
jest.mock('../services/walletService', () => ({ updateBalanceWithLedger: jest.fn() }));
jest.mock('../services/eventBus', () => ({ publish: jest.fn() }));
jest.mock('../utils/logger', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../utils/manualExecutorReceipt', () => ({
    generateExecutorReceiptBase64: jest.fn(() => 'data:image/jpeg;base64,cmVjZWlwdA==')
}));
jest.mock('../services/proofStorageService', () => ({
    saveProofImage: jest.fn(() => 'proofs/system-api-receipt.jpg')
}));

const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const { updateBalanceWithLedger } = require('../services/walletService');
const eventBus = require('../services/eventBus');
const { generateExecutorReceiptBase64 } = require('../utils/manualExecutorReceipt');
const { saveProofImage } = require('../services/proofStorageService');
const {
    completeApiTransactionWithReference,
    completeApiTransaction
} = require('../services/apiExecutionLifecycleService');

const createTransaction = (overrides = {}) => ({
    _id: 'tx-1',
    customId: 'ATT-2608-0142',
    status: 'processing',
    amount: 1600,
    vodafoneNumber: '01108172258',
    proofImages: [],
    apiResultData: {},
    set: jest.fn(),
    save: jest.fn().mockResolvedValue(true),
    ...overrides
});

const executorGroup = { _id: 'group-1', name: 'API Executor', parentGroupId: 'manager-1' };

describe('API executor receipt lifecycle', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        updateBalanceWithLedger.mockResolvedValue({ balanceAfter: 4000 });
    });

    test('stores the system receipt first and preserves the provider receipt', async () => {
        const tx = createTransaction();
        await completeApiTransactionWithReference({
            tx,
            executorGroup,
            apiResult: {
                reference_number: 'REF-7788',
                external_transaction_id: 'PROV-456'
            },
            receiptProof: 'proofs/provider-original.jpg'
        });

        expect(generateExecutorReceiptBase64).toHaveBeenCalledWith(expect.objectContaining({
            customerPhone: '01108172258',
            executionNumber: 'REF-7788',
            executorReference: 'PROV-456',
            executionReferenceLabel: 'مرجع تنفيذ API',
            serviceName: 'محافظ كاش'
        }));
        expect(saveProofImage).toHaveBeenCalled();
        expect(tx.proofImage).toBe('proofs/system-api-receipt.jpg');
        expect(tx.proofImages).toEqual([
            'proofs/system-api-receipt.jpg',
            'proofs/provider-original.jpg'
        ]);
        expect(tx.status).toBe('completed');
        expect(tx.completedAt).toBeInstanceOf(Date);
    });

    test('generates the receipt when a delayed API transaction becomes completed', async () => {
        const tx = createTransaction({
            executorGroupId: 'group-1',
            apiResultData: {
                waitingApiAutoCompletion: true,
                referenceNumber: 'REF-9900',
                externalTransactionId: 'PROV-9900',
                apiProviderReceiptProof: 'proofs/provider-delayed.jpg'
            }
        });
        Transaction.findById.mockResolvedValue(tx);
        ExecutorGroup.findById.mockResolvedValue(executorGroup);

        await expect(completeApiTransaction('tx-1', 'group-1')).resolves.toEqual({ completed: true });

        expect(tx.proofImage).toBe('proofs/system-api-receipt.jpg');
        expect(tx.proofImages).toEqual([
            'proofs/system-api-receipt.jpg',
            'proofs/provider-delayed.jpg'
        ]);
        expect(eventBus.publish).toHaveBeenCalledWith('transfer:completed', expect.any(Object));
    });
});
