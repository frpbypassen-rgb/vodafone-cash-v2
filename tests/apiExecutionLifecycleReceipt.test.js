'use strict';

jest.mock('../models/Transaction', () => ({
    findById: jest.fn(),
    countDocuments: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn()
}));
jest.mock('axios', () => ({ post: jest.fn(), get: jest.fn() }));
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
const axios = require('axios');
const {
    completeApiTransactionWithReference,
    completeApiTransaction,
    warnProviderPaidAwaitingCompletion
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
        delete process.env.FINANCIAL_SCHEDULERS_ENABLED;
        updateBalanceWithLedger.mockResolvedValue({ balanceAfter: 4000 });
        Transaction.findOneAndUpdate.mockImplementation(async () => {
            const results = Transaction.findById.mock.results;
            if (!results.length) return null;
            const tx = await results[results.length - 1].value;
            if (!tx || tx.status !== 'processing' || tx.apiResultData?.waitingApiAutoCompletion !== true) {
                return null;
            }
            tx.apiResultData = {
                ...tx.apiResultData,
                waitingApiAutoCompletion: false,
                completionClaimedAt: new Date()
            };
            return tx;
        });
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

    test('leaves a provider-paid row unchanged while schedulers are off and completes it once when they are on', async () => {
        process.env.FINANCIAL_SCHEDULERS_ENABLED = 'false';
        const tx = createTransaction({
            executorGroupId: 'group-1',
            apiResultData: {
                waitingApiAutoCompletion: true,
                referenceNumber: 'REF-9900',
                externalTransactionId: 'PROV-9900'
            }
        });
        Transaction.findById.mockResolvedValue(tx);
        ExecutorGroup.findById.mockResolvedValue(executorGroup);
        Transaction.countDocuments.mockResolvedValue(1);
        const log = { warn: jest.fn() };

        await expect(warnProviderPaidAwaitingCompletion(log)).resolves.toBe(1);
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Provider-paid transactions awaiting local completion: 1'));
        await expect(completeApiTransaction('tx-1', 'group-1')).resolves.toEqual({
            completed: false,
            reason: 'financial_schedulers_disabled'
        });
        expect(updateBalanceWithLedger).not.toHaveBeenCalled();
        expect(tx.save).not.toHaveBeenCalled();
        expect(tx.status).toBe('processing');
        expect(axios.post).not.toHaveBeenCalled();

        process.env.FINANCIAL_SCHEDULERS_ENABLED = 'true';
        await expect(completeApiTransaction('tx-1', 'group-1')).resolves.toEqual({ completed: true });
        await expect(completeApiTransaction('tx-1', 'group-1')).resolves.toEqual({
            completed: false,
            reason: 'invalid_status:completed'
        });
        expect(updateBalanceWithLedger).toHaveBeenCalledTimes(1);
        expect(axios.post).not.toHaveBeenCalled();
        delete process.env.FINANCIAL_SCHEDULERS_ENABLED;
    });

    test('the provider-paid listing is a read', async () => {
        const { listProviderPaidAwaitingCompletion } = require('../scripts/listProviderPaidAwaitingCompletion');
        const query = {
            select: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue([{ customId: 'ATT-1' }])
        };
        const model = {
            find: jest.fn(() => query),
            updateOne: jest.fn(),
            deleteMany: jest.fn()
        };
        await expect(listProviderPaidAwaitingCompletion(model)).resolves.toEqual([{ customId: 'ATT-1' }]);
        expect(model.find).toHaveBeenCalledWith(expect.objectContaining({
            status: 'processing',
            'apiResultData.waitingApiAutoCompletion': true
        }));
        expect(model.updateOne).not.toHaveBeenCalled();
        expect(model.deleteMany).not.toHaveBeenCalled();
    });

    test('uses the Sefa service and currency labels for an API Sefa receipt', async () => {
        const tx = createTransaction({ transferType: 'sefa_niger', amount: 5 });

        await completeApiTransactionWithReference({
            tx,
            executorGroup,
            apiResult: { reference_number: 'SEFA-7788' }
        });

        expect(generateExecutorReceiptBase64).toHaveBeenCalledWith(expect.objectContaining({
            serviceName: 'سيفا النيجر',
            amountCurrencyLabel: 'سيفا',
            transferType: 'sefa_niger'
        }));
    });
});
