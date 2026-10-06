'use strict';

jest.mock('../models/Employee');
jest.mock('../models/Transaction');
jest.mock('../utils/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../models/ExecutorGroup', () => ({ findByIdAndUpdate: jest.fn() }));
jest.mock('../services/adminFinancialMutationService', () => ({
    withOptionalMongoTransaction: jest.fn((work) => work(null))
}));
jest.mock('../services/zaynpayApi', () => ({ inquiry: jest.fn(), pay: jest.fn() }));
jest.mock('../services/providerDispatchClaimService', () => ({
    refundBlockedByUnresolvedProvider: jest.fn(() => null),
    markProviderResultUnresolved: jest.fn().mockResolvedValue({ marked: true })
}));
jest.mock('../utils/helpers', () => ({ syncBotBalance: jest.fn().mockResolvedValue(0) }));
jest.mock('../services/auditService', () => ({ logAction: jest.fn().mockResolvedValue(true) }));
jest.mock('../services/lockService', () => ({
    acquireLock: jest.fn().mockResolvedValue({ release: jest.fn() }),
    releaseLock: jest.fn().mockResolvedValue(true)
}));
jest.mock('../services/eventBus', () => ({ publish: jest.fn() }));
jest.mock('../services/executorCompletionOutboxService', () => ({
    enqueueCompletionEffects: jest.fn().mockResolvedValue(),
    runCompletionOutboxTick: jest.fn().mockResolvedValue(false)
}));
jest.mock('../utils/receiptGenerator', () => ({
    generateReceiptBase64: jest.fn().mockResolvedValue('data:image/jpeg;base64,AAECAwQ=')
}));
jest.mock('../utils/manualExecutorReceipt', () => ({
    generateManualExecutorReceiptBase64: jest.fn().mockResolvedValue(
        `data:image/png;base64,${jest.requireActual('fs').readFileSync(jest.requireActual('path').join(__dirname, '..', 'public', 'images', 'instapay_logo.png')).toString('base64')}`
    ),
    maskManualExecutionNumber: jest.fn((value) => {
        const input = String(value || '');
        if (!input) return '';
        if (input === '01108172258') return '011****2258';
        if (input === '899') return '01******899';
        if (input === '2258') return '01*****2258';
        return `masked:${input}`;
    }),
    ManualExecutionNumberError: class ManualExecutionNumberError extends Error {}
}));
jest.mock('../models/Admin', () => ({ find: jest.fn().mockResolvedValue([]) }));
jest.mock('../models/User', () => ({
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn().mockResolvedValue({})
}));
jest.mock('../models/ClientCompany', () => ({
    findById: jest.fn(),
    findOneAndUpdate: jest.fn(),
    findByIdAndUpdate: jest.fn().mockResolvedValue({})
}));
jest.mock('../services/cancellationReceiptService', () => ({
    attachCancellationReceipt: jest.fn().mockResolvedValue('proofs/CAN-1_cancellation_receipt.jpg')
}));
jest.mock('../services/whatsappReceiptDeliveryService', () => ({
    sendCancelledTransactionReceipt: jest.fn().mockResolvedValue({ success: true }),
    sendCompletedTransactionReceipt: jest.fn()
}));
jest.mock('../services/manualExecutorReceiptReferenceService', () => ({
    reserveManualExecutorReceiptReference: jest.fn().mockResolvedValue({
        prefix: '999',
        sequence: 1,
        reference: '999001'
    })
}));

const fs = require('fs');
const path = require('path');
const VALID_PNG_DATA_URL = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, '..', 'public', 'images', 'instapay_logo.png')).toString('base64')}`;
const SECOND_PNG_DATA_URL = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, '..', 'public', 'images', 'executor-3d-alert.png')).toString('base64')}`;
const logger = require('../utils/logger');
const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const ExecutorGroup = require('../models/ExecutorGroup');
const zaynpay = require('../services/zaynpayApi');
const { markProviderResultUnresolved } = require('../services/providerDispatchClaimService');
const { syncBotBalance } = require('../utils/helpers');
const { logAction } = require('../services/auditService');
const { acquireLock, releaseLock } = require('../services/lockService');
const eventBus = require('../services/eventBus');
const {
    enqueueCompletionEffects,
    runCompletionOutboxTick
} = require('../services/executorCompletionOutboxService');
const { generateManualExecutorReceiptBase64, maskManualExecutionNumber } = require('../utils/manualExecutorReceipt');
const { reserveManualExecutorReceiptReference } = require('../services/manualExecutorReceiptReferenceService');
const { sendCancelledTransactionReceipt } = require('../services/whatsappReceiptDeliveryService');
const { attachCancellationReceipt } = require('../services/cancellationReceiptService');
const controller = require('../controllers/executorTransactionController');

describe('Executor web transaction completion', () => {
    let req;
    let res;
    let tx;

    beforeEach(() => {
        jest.clearAllMocks();
        delete process.env.EXTERNAL_API_ENABLED;
        delete process.env.BULLMQ_WORKERS_ENABLED;
        jest.spyOn(fs, 'existsSync').mockReturnValue(true);
        jest.spyOn(fs, 'writeFileSync').mockImplementation(() => {});
        jest.spyOn(fs, 'unlinkSync').mockImplementation(() => {});

        req = {
            params: { id: 'tx-1' },
            body: {},
            session: { executorId: 'employee-1' },
            executorEmployee: {
                _id: { toString: () => 'employee-1' },
                name: 'منفذ الاختبار',
                status: 'active',
                groupId: {
                    _id: 'group-1',
                    name: 'مجموعة الاختبار',
                    status: 'active',
                    manualReceiptPrefix: '999',
                    parentGroupId: 'parent-1'
                }
            }
        };
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis()
        };
        tx = {
            _id: { toString: () => 'tx-1' },
            customId: 'EXEC-TEST-001',
            status: 'accepted',
            amount: 250,
            transferType: 'vodafone',
            vodafoneNumber: '01108172258',
            notes: 'ملاحظة العميل',
            save: jest.fn().mockResolvedValue(true)
        };
        Transaction.findOne.mockResolvedValue(tx);
        Transaction.findOneAndUpdate.mockImplementation(async (filter, update) => {
            if (tx.status !== filter.status || tx.operatorId !== filter.operatorId) return null;
            Object.assign(tx, update.$set);
            return tx;
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('generates a system receipt when the executor completes without a proof image', async () => {
        await controller.postCompleteTask(req, res);

        expect(Transaction.findOne).toHaveBeenCalledWith(expect.objectContaining({
            _id: 'tx-1',
            status: 'accepted'
        }));
        expect(reserveManualExecutorReceiptReference).toHaveBeenCalledWith({ group: req.executorEmployee.groupId });
        expect(generateManualExecutorReceiptBase64).toHaveBeenCalledWith(expect.objectContaining({
            amount: 250,
            customId: 'EXEC-TEST-001',
            customerPhone: '01108172258',
            executorReference: '999001',
            serviceName: 'محافظ كاش'
        }));
        expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
        expect(tx.status).toBe('completed');
        expect(tx.$where).toEqual({ status: 'accepted', operatorId: tx.operatorId });
        expect(tx.proofImage).toMatch(/^EXEC-TEST-001_manual_[a-z0-9]+\.jpg$/);
        expect(tx.proofImages).toEqual([tx.proofImage]);
        expect(tx.manualExecutorReceiptReference).toBe('999001');
        expect(tx.adminNotes).toContain('999001');
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
        expect(releaseLock).toHaveBeenCalled();
    });

    test('rejects a task that is not assigned to the current executor', async () => {
        req.body.imageBase64 = VALID_PNG_DATA_URL;
        Transaction.findOne.mockResolvedValue(null);

        await controller.postCompleteTask(req, res);

        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
        expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    test('completes a legacy accepted task when its stale owner key cannot resolve to another employee', async () => {
        const legacyTx = {
            ...tx,
            operatorId: 'legacy-executor-login',
            executorGroupId: 'group-1',
            executorName: 'منفذ الاختبار'
        };
        Transaction.findOne.mockResolvedValue(null);
        Transaction.findById.mockResolvedValue(legacyTx);
        Employee.countDocuments.mockResolvedValue(0);

        await controller.postCompleteTask(req, res);

        expect(Transaction.findById).toHaveBeenCalledWith('tx-1');
        expect(Employee.countDocuments).toHaveBeenCalled();
        expect(legacyTx.status).toBe('completed');
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    test('allows a Sefa Niger task to complete with a generated receipt only', async () => {
        tx.transferType = 'sefa_niger';

        await controller.postCompleteTask(req, res);

        expect(res.status).not.toHaveBeenCalledWith(400);
        expect(reserveManualExecutorReceiptReference).toHaveBeenCalled();
        expect(tx.proofImages).toEqual([tx.proofImage]);
        expect(tx.executorProofImages).toEqual([]);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    test('keeps the Sefa executor proof private and exposes only the system receipt', async () => {
        tx.transferType = 'sefa_niger';
        req.body = {
            imageBase64: VALID_PNG_DATA_URL,
            executionNumber: '2258'
        };

        await controller.postCompleteTask(req, res);

        expect(generateManualExecutorReceiptBase64).toHaveBeenCalledWith(expect.objectContaining({
            serviceName: 'سيفا النيجر',
            amountCurrencyLabel: 'سيفا',
            transferType: 'sefa_niger'
        }));
        expect(tx.proofImages).toEqual([tx.proofImage]);
        expect(tx.proofImage).toMatch(/^EXEC-TEST-001_manual_[a-z0-9]+\.jpg$/);
        expect(tx.executorProofImages).toHaveLength(1);
        expect(tx.executorProofImages[0]).toMatch(/^EXEC-TEST-001_[a-z0-9]+(?:_\d+)?\.png$/);
        expect(tx.executorExecutionNumber).toBe('2258');
        expect(tx.executorExecutionNumberMasked).toBe('01*****2258');
    });

    test('sends the cancellation receipt on WhatsApp when the executor cancels', async () => {
        req.body.reason = 'الرقم غير مسجل';
        tx.operatorId = 'employee-1';
        tx.userId = 'customer-1';
        tx.costLYD = 12.5;
        tx.companyName = 'شركة النور';
        Transaction.findById.mockResolvedValue(tx);
        Employee.findById.mockResolvedValue({
            _id: { toString: () => 'employee-1' },
            name: 'منفذ الاختبار'
        });

        await controller.postCancelTask(req, res);

        expect(sendCancelledTransactionReceipt).toHaveBeenCalledWith(tx);
        expect(res.json).toHaveBeenCalledWith({ success: true });
    });

    test('a repeated cancellation cannot refund the customer twice', async () => {
        req.body.reason = 'الرقم غير صحيح';
        tx.operatorId = 'employee-1';
        tx.userId = 'customer-1';
        tx.costLYD = 12.5;
        Transaction.findById.mockImplementation(async () => tx);
        Employee.findById.mockResolvedValue({ _id: { toString: () => 'employee-1' }, name: 'منفذ الاختبار' });

        await controller.postCancelTask(req, res);
        await controller.postCancelTask(req, res);

        expect(require('../models/User').findOneAndUpdate).toHaveBeenCalledTimes(1);
        expect(Transaction.findOneAndUpdate).toHaveBeenCalledTimes(1);
        expect(tx.status).toBe('rejected');
    });

    test('returning a task uses an accepted and owned state transition', async () => {
        req.body.reason = 'لا يمكن التنفيذ';
        tx.operatorId = 'employee-1';
        Transaction.findById.mockResolvedValue(tx);
        Employee.findById.mockResolvedValue({ _id: { toString: () => 'employee-1' } });

        await controller.postReturnTask(req, res);

        expect(Transaction.findOneAndUpdate).toHaveBeenCalledWith(
            expect.objectContaining({ _id: tx._id, status: 'accepted', operatorId: 'employee-1' }),
            expect.objectContaining({ $set: expect.objectContaining({ status: 'pending' }) })
        );
    });

    test('rejects a partially numeric amount before any balance change', async () => {
        req.body.newAmount = '100abc';
        Employee.findById.mockResolvedValue({ _id: { toString: () => 'employee-1' } });

        await controller.postEditAmount(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(Transaction.findOne).not.toHaveBeenCalled();
        expect(require('../models/User').findOneAndUpdate).not.toHaveBeenCalled();
    });

    test('does not change an amount when its balance owner is unknown', async () => {
        req.body.newAmount = '300';
        tx.operatorId = 'employee-1';
        tx.costLYD = 20;
        tx.exchangeRate = 10;
        Employee.findById.mockResolvedValue({ _id: { toString: () => 'employee-1' } });

        await controller.postEditAmount(req, res);

        expect(res.status).toHaveBeenCalledWith(409);
        expect(tx.save).not.toHaveBeenCalled();
    });

    test('requires a cancellation reason before changing the transaction', async () => {
        await controller.postCancelTask(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ success: false, error: 'سبب الإلغاء مطلوب.' });
        expect(Transaction.findById).not.toHaveBeenCalled();
    });

    test('stores proof, completes once, recalculates balances, and publishes notification', async () => {
        req.body = {
            imageBase64: VALID_PNG_DATA_URL,
            imagesBase64: [VALID_PNG_DATA_URL],
            executionNumber: '01108172258'
        };

        await controller.postCompleteTask(req, res);

        expect(acquireLock).toHaveBeenCalledWith('executor-complete:tx-1', 30000, { retryCount: 1 });
        expect(Transaction.findOne).toHaveBeenCalledWith(expect.objectContaining({
            _id: 'tx-1',
            status: 'accepted'
        }));
        expect(fs.writeFileSync).toHaveBeenCalledTimes(2);
        expect(tx.status).toBe('completed');
        expect(tx.proofImage).toMatch(/^EXEC-TEST-001_manual_[a-z0-9]+\.jpg$/);
        expect(tx.proofImages).toEqual([tx.proofImage]);
        expect(tx.executorProofImages).toHaveLength(1);
        expect(tx.executorExecutionNumber).toBe('01108172258');
        expect(tx.executorSenderPhone).toBe('011****2258');
        expect(tx.executorExecutionNumberMasked).toBe('011****2258');
        expect(tx.manualExecutorReceiptReference).toBe('999001');
        expect(tx.save).toHaveBeenCalledTimes(1);
        expect(maskManualExecutionNumber).toHaveBeenCalledWith('01108172258');
        expect(generateManualExecutorReceiptBase64).toHaveBeenCalled();
        expect(syncBotBalance).toHaveBeenCalledWith('group-1', { session: null });
        expect(syncBotBalance).toHaveBeenCalledWith('parent-1', { session: null });
        expect(enqueueCompletionEffects).toHaveBeenCalledWith(expect.objectContaining({
            tx,
            emp: req.executorEmployee,
            session: null
        }));
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
        expect(releaseLock).toHaveBeenCalled();
    });

    test('does not report failure or delete committed proofs when releasing a lock fails', async () => {
        releaseLock.mockRejectedValueOnce(new Error('redis://user:secret@internal-host'));

        await controller.postCompleteTask(req, res);

        expect(tx.status).toBe('completed');
        expect(tx.save).toHaveBeenCalledTimes(1);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
        expect(fs.unlinkSync).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith('Executor completion-lock-release failed', { errorType: 'Error', databaseCode: undefined });
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
    });

    test('logs failed post-completion side effects without undoing a completed operation', async () => {
        runCompletionOutboxTick.mockRejectedValueOnce(new Error('effect failure'));
        const before = { amount: tx.amount, costLYD: tx.costLYD, commission: tx.commission };

        await controller.postCompleteTask(req, res);

        expect(tx.status).toBe('completed');
        expect({ amount: tx.amount, costLYD: tx.costLYD, commission: tx.commission }).toEqual(before);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
        expect(require('../models/User').findOneAndUpdate).not.toHaveBeenCalled();
        expect(ExecutorGroup.findByIdAndUpdate).not.toHaveBeenCalled();
        expect(fs.unlinkSync).not.toHaveBeenCalled();
        expect(logger.error).toHaveBeenCalledWith('Executor completion-effects failed', expect.any(Object));
    });

    test('reports a balance persistence failure before commit and cleans uncommitted proofs', async () => {
        syncBotBalance.mockRejectedValueOnce(new Error('mongodb://user:secret@internal-host'));
        await controller.postCompleteTask(req, res);
        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ success: false, error: 'تعذر إنهاء العملية.' });
        expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
        expect(eventBus.publish).not.toHaveBeenCalled();
        expect(logAction).not.toHaveBeenCalled();
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
    });

    test('cleans uncommitted proofs and conceals a database failure', async () => {
        tx.save.mockRejectedValueOnce(new Error('mongodb://user:secret@internal-host'));

        await controller.postCompleteTask(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ success: false, error: 'تعذر إنهاء العملية.' });
        expect(fs.unlinkSync).toHaveBeenCalledTimes(1);
        expect(eventBus.publish).not.toHaveBeenCalled();
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
    });

    test('does not expose database connection details before any completion write', async () => {
        Transaction.findOne.mockRejectedValueOnce(new Error('mongodb://user:secret@internal-host'));

        await controller.postCompleteTask(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ success: false, error: 'تعذر إنهاء العملية.' });
        expect(tx.save).not.toHaveBeenCalled();
        expect(fs.writeFileSync).not.toHaveBeenCalled();
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
    });

    test.each(['constructor', 'toString', '__proto__', null])(
        'treats an unknown completion error as an internal failure: %p', async (message) => {
            Transaction.findOne.mockRejectedValueOnce(message === null ? null : new Error(message));

            await controller.postCompleteTask(req, res);

            expect(res.status).toHaveBeenCalledWith(500);
            expect(res.json).toHaveBeenCalledWith({ success: false, error: 'تعذر إنهاء العملية.' });
            expect(tx.save).not.toHaveBeenCalled();
            expect(fs.writeFileSync).not.toHaveBeenCalled();
        }
    );

    test('keeps a refunded cancellation successful when receipt generation and its note fail', async () => {
        req.body.reason = 'الرقم غير صحيح';
        tx.operatorId = 'employee-1';
        tx.userId = 'customer-1';
        tx.costLYD = 12.5;
        Transaction.findById.mockResolvedValue(tx);
        Employee.findById.mockResolvedValue({ _id: { toString: () => 'employee-1' }, name: 'منفذ الاختبار' });
        attachCancellationReceipt.mockRejectedValueOnce(new Error('apiKey=secret'));
        tx.save.mockRejectedValueOnce(new Error('database unavailable'));

        await controller.postCancelTask(req, res);
        await controller.postCancelTask(req, res);

        expect(res.json).toHaveBeenCalledWith({ success: true });
        expect(require('../models/User').findOneAndUpdate).toHaveBeenCalledTimes(1);
        expect(tx.status).toBe('rejected');
        expect(tx.adminNotes).toContain('تعذر توليد إيصال الإلغاء');
        expect(tx.adminNotes).not.toContain('secret');
        expect(sendCancelledTransactionReceipt).not.toHaveBeenCalled();
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
    });

    test.each(['postRetryPartProof', 'postRateExecutor', 'postVoiceNote'])(
        '%s cannot change a task belonging to another group',
        async (handler) => {
            tx.executorGroupId = 'foreign-group';
            tx.managerGroupId = 'foreign-manager';
            Transaction.findById.mockResolvedValue(tx);
            req.body = { rating: 5, note: 'test', base64: 'data:audio/webm;base64,AAEC' };

            await controller[handler](req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(tx.save).not.toHaveBeenCalled();
            expect(tx.executorRating).toBeUndefined();
            expect(tx.voiceNote).toBeUndefined();
        }
    );

    test('completes a bank transfer from the attached proof without a phone or generated receipt', async () => {
        tx.transferType = 'bank_account';
        tx.accountNumber = 'EG380019000500000000263180002';
        tx.amount = 1500;
        req.body = {
            imageBase64: VALID_PNG_DATA_URL,
            imagesBase64: [
                VALID_PNG_DATA_URL,
                SECOND_PNG_DATA_URL
            ],
            executionNumber: '01108172258'
        };

        await controller.postCompleteTask(req, res);

        expect(reserveManualExecutorReceiptReference).not.toHaveBeenCalled();
        expect(generateManualExecutorReceiptBase64).not.toHaveBeenCalled();
        expect(maskManualExecutionNumber).not.toHaveBeenCalled();
        expect(tx.status).toBe('completed');
        expect(tx.proofImage).toMatch(/^EXEC-TEST-001_[a-z0-9]+_1\.png$/);
        expect(tx.proofImages).toEqual([tx.proofImage]);
        expect(tx.executorProofImages).toHaveLength(1);
        expect(tx.executorProofImages[0]).toMatch(/_2\.png$/);
        expect(tx.executorSenderEntries).toEqual([]);
        expect(tx.executorExecutionNumber).toBeUndefined();
        expect(tx.executorSenderPhone).toBeUndefined();
        expect(tx.manualExecutorReceiptReference).toBeUndefined();
        expect(tx.adminNotes).toContain('إثبات التحويل البنكي');
        expect(tx.adminNotes || '').not.toContain('تم توليد إيصال');
        expect(enqueueCompletionEffects).toHaveBeenCalled();
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    test('rejects a bank transfer that has no proof image', async () => {
        tx.transferType = 'bank_account';

        await controller.postCompleteTask(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
            success: false,
            error: 'إرفاق صورة إثبات التحويل البنكي إجباري.'
        });
        expect(generateManualExecutorReceiptBase64).not.toHaveBeenCalled();
        expect(tx.save).not.toHaveBeenCalled();
    });

    test('records each split part for its own proof and does not create a combined receipt or financial movement', async () => {
        tx.amount = 2500;
        tx.costLYD = 180.5;
        tx.commission = 4.25;
        tx.vodafoneNumber = '01011112222';
        req.body = {
            senderEntries: [
                { phone: '01108172258', amount: 1000 },
                { phone: '01000926306', amount: 1500 }
            ]
        };

        await controller.postCompleteTask(req, res);

        expect(reserveManualExecutorReceiptReference).not.toHaveBeenCalled();
        expect(generateManualExecutorReceiptBase64).not.toHaveBeenCalled();
        expect(tx.status).toBe('completed');
        expect(tx.amount).toBe(2500);
        expect(tx.costLYD).toBe(180.5);
        expect(tx.commission).toBe(4.25);
        expect(tx.proofImages).toEqual([]);
        expect(tx.proofImage).toBeUndefined();
        expect(tx.executorSenderEntries).toEqual([
            expect.objectContaining({
                partId: '1',
                phone: '01108172258',
                amount: 1000,
                status: 'success',
                customerProof: expect.objectContaining({ key: 'tx-1:1', status: 'pending' })
            }),
            expect.objectContaining({
                partId: '2',
                phone: '01000926306',
                amount: 1500,
                status: 'success',
                customerProof: expect.objectContaining({ key: 'tx-1:2', status: 'pending' })
            })
        ]);
        expect(tx.executorSenderEntries[0].confirmedAt).toBeInstanceOf(Date);
        expect(tx.executorSenderEntries[1].confirmedAt).toEqual(tx.executorSenderEntries[0].confirmedAt);
        expect(syncBotBalance).toHaveBeenCalledWith('group-1', { session: null });
        expect(syncBotBalance).toHaveBeenCalledWith('parent-1', { session: null });
        expect(enqueueCompletionEffects).toHaveBeenCalled();
        expect(tx.save).toHaveBeenCalledTimes(1);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    test('rejects splitting a bank transfer into more than one payment', async () => {
        tx.transferType = 'bank_transfer';
        tx.amount = 250;
        req.body = {
            imagesBase64: [VALID_PNG_DATA_URL],
            senderEntries: [
                { phone: '01108172258', amount: 100, proofImageBase64: VALID_PNG_DATA_URL },
                { phone: '01095433913', amount: 150, proofImageBase64: VALID_PNG_DATA_URL }
            ]
        };

        await controller.postCompleteTask(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
            success: false,
            error: 'التحويل البنكي يُنفَّذ دفعة واحدة ولا يقبل التقسيم.'
        });
        expect(tx.save).not.toHaveBeenCalled();
        expect(generateManualExecutorReceiptBase64).not.toHaveBeenCalled();
    });

    test('refuses ZaynPay execution before any read or ledger write when the provider switch is off', async () => {
        process.env.EXTERNAL_API_ENABLED = 'false';
        const before = tx.status;
        await controller.executeViaZaynPay(req, res);
        delete process.env.EXTERNAL_API_ENABLED;

        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: false,
            code: 'API_EXECUTION_UNAVAILABLE'
        }));
        expect(Transaction.findById).not.toHaveBeenCalled();
        expect(tx.save).not.toHaveBeenCalled();
        expect(tx.status).toBe(before);
    });

    test('does not block direct ZaynPay execution only because BullMQ workers are off', async () => {
        process.env.BULLMQ_WORKERS_ENABLED = 'false';
        delete process.env.EXTERNAL_API_ENABLED;
        await controller.executeViaZaynPay(req, res);
        delete process.env.BULLMQ_WORKERS_ENABLED;

        expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({
            code: 'API_EXECUTION_UNAVAILABLE'
        }));
        expect(tx.save).not.toHaveBeenCalled();
        expect(tx.status).toBe('accepted');
    });

    test('does not inquire, claim, or pay a ZaynPay task outside the current tenant', async () => {
        const previousMode = process.env.TENANT_MODE;
        process.env.TENANT_MODE = 'multi';
        req.tenant = { _id: 'tenant-a' };
        Employee.findById.mockReturnValue({ populate: jest.fn().mockResolvedValue({
            _id: 'employee-1', webUsername: 'zaynapi@ahram.com',
            groupId: { _id: 'group-1' }
        }) });
        Transaction.findById.mockResolvedValue({
            ...tx,
            operatorId: 'employee-1',
            executorGroupId: 'group-1',
            tenantId: 'tenant-b',
            status: 'accepted'
        });

        await controller.executeViaZaynPay(req, res);

        expect(res.status).toHaveBeenCalledWith(403);
        expect(zaynpay.inquiry).not.toHaveBeenCalled();
        expect(zaynpay.pay).not.toHaveBeenCalled();
        expect(Transaction.findOneAndUpdate).not.toHaveBeenCalled();
        expect(ExecutorGroup.findByIdAndUpdate).not.toHaveBeenCalled();
        if (previousMode === undefined) delete process.env.TENANT_MODE;
        else process.env.TENANT_MODE = previousMode;
    });

    test('does not call ZaynPay when another request wins the dispatch claim', async () => {
        Employee.findById.mockReturnValue({ populate: jest.fn().mockResolvedValue({
            _id: 'employee-1', webUsername: 'zaynapi@ahram.com',
            groupId: { _id: 'group-1' }
        }) });
        Transaction.findById.mockResolvedValue({ ...tx, operatorId: 'employee-1', executorGroupId: 'group-1' });
        zaynpay.inquiry.mockResolvedValue({ billId: 'bill-1' });
        Transaction.findOneAndUpdate.mockResolvedValue(null);

        await controller.executeViaZaynPay(req, res);

        expect(res.status).toHaveBeenCalledWith(409);
        expect(zaynpay.pay).not.toHaveBeenCalled();
    });

    test('holds an uncertain ZaynPay result for manual review after claiming', async () => {
        Employee.findById.mockReturnValue({ populate: jest.fn().mockResolvedValue({
            _id: 'employee-1', webUsername: 'zaynapi@ahram.com',
            groupId: { _id: 'group-1' }
        }) });
        Transaction.findById.mockResolvedValue({ ...tx, operatorId: 'employee-1', executorGroupId: 'group-1' });
        zaynpay.inquiry.mockResolvedValue({ billId: 'bill-1' });
        Transaction.findOneAndUpdate.mockResolvedValue({ _id: 'tx-1' });
        zaynpay.pay.mockRejectedValue(new Error('connection lost'));

        await controller.executeViaZaynPay(req, res);

        expect(zaynpay.pay).toHaveBeenCalledTimes(1);
        expect(markProviderResultUnresolved).toHaveBeenCalledWith(expect.objectContaining({ txId: 'tx-1', source: 'zaynpay' }));
        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PROVIDER_RESULT_UNRESOLVED' }));
    });

    test('conceals provider inquiry details and never claims or pays on inquiry failure', async () => {
        Employee.findById.mockReturnValue({ populate: jest.fn().mockResolvedValue({
            _id: 'employee-1', webUsername: 'zaynapi@ahram.com', groupId: { _id: 'group-1' }
        }) });
        Transaction.findById.mockResolvedValue({ ...tx, operatorId: 'employee-1', executorGroupId: 'group-1' });
        zaynpay.inquiry.mockRejectedValueOnce(new Error('https://provider/pay?apiKey=secret'));

        await controller.executeViaZaynPay(req, res);

        expect(res.json).toHaveBeenCalledWith({ success: false, error: 'تعذر الاستعلام لدى مزود الدفع. أعد المحاولة.' });
        expect(Transaction.findOneAndUpdate).not.toHaveBeenCalled();
        expect(zaynpay.pay).not.toHaveBeenCalled();
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
    });

    test('holds a paid task when its receipt is invalid instead of applying a local settlement', async () => {
        Employee.findById.mockReturnValue({ populate: jest.fn().mockResolvedValue({
            _id: 'employee-1', webUsername: 'zaynapi@ahram.com', groupId: { _id: 'group-1' }
        }) });
        Transaction.findById.mockResolvedValue({ ...tx, operatorId: 'employee-1', executorGroupId: 'group-1' });
        zaynpay.inquiry.mockResolvedValue({ billId: 'bill-1' });
        Transaction.findOneAndUpdate.mockResolvedValueOnce({ _id: 'tx-1' });
        zaynpay.pay.mockResolvedValueOnce({ success: true, refNumber: 'REF-1' });
        generateManualExecutorReceiptBase64.mockResolvedValueOnce('');

        await controller.executeViaZaynPay(req, res);

        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PROVIDER_RESULT_UNRESOLVED' }));
        expect(markProviderResultUnresolved).toHaveBeenCalledWith(expect.objectContaining({ txId: 'tx-1' }));
        expect(Transaction.findOneAndUpdate).toHaveBeenCalledTimes(1);
        expect(ExecutorGroup.findByIdAndUpdate).not.toHaveBeenCalled();
        expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    test('does not expose or persist a provider secret even if marking the hold also fails', async () => {
        Employee.findById.mockReturnValue({ populate: jest.fn().mockResolvedValue({
            _id: 'employee-1', webUsername: 'zaynapi@ahram.com', groupId: { _id: 'group-1' }
        }) });
        Transaction.findById.mockResolvedValue({ ...tx, operatorId: 'employee-1', executorGroupId: 'group-1' });
        zaynpay.inquiry.mockResolvedValue({ billId: 'bill-1' });
        Transaction.findOneAndUpdate.mockResolvedValueOnce({ _id: 'tx-1' });
        zaynpay.pay.mockRejectedValueOnce(new Error('apiKey=secret'));
        markProviderResultUnresolved.mockRejectedValueOnce(new Error('mongodb://user:secret@host'));

        await controller.executeViaZaynPay(req, res);

        expect(res.status).toHaveBeenCalledWith(409);
        expect(zaynpay.pay).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(markProviderResultUnresolved.mock.calls)).not.toContain('secret');
        expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
        expect(JSON.stringify(res.json.mock.calls)).not.toContain('secret');
        expect(ExecutorGroup.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    test('settles a successful ZaynPay payment once and blocks a repeat', async () => {
        Employee.findById.mockReturnValue({ populate: jest.fn().mockResolvedValue({
            _id: 'employee-1', webUsername: 'zaynapi@ahram.com',
            groupId: { _id: 'group-1', parentGroupId: 'parent-1', token: 'bot-token' }
        }) });
        Transaction.findById.mockResolvedValue({ ...tx, operatorId: 'employee-1', executorGroupId: 'group-1' });
        zaynpay.inquiry.mockResolvedValue({ billId: 'bill-1' });
        zaynpay.pay.mockResolvedValue({ success: true, refNumber: 'REF-1', transactionNumber: 'ZP-1' });
        Transaction.findOneAndUpdate.mockResolvedValueOnce({ _id: 'tx-1' }).mockResolvedValueOnce({ _id: 'tx-1', status: 'completed' });
        ExecutorGroup.findByIdAndUpdate.mockResolvedValue({ _id: 'group-1' });

        await controller.executeViaZaynPay(req, res);

        expect(zaynpay.pay).toHaveBeenCalledTimes(1);
        expect(Transaction.findOneAndUpdate).toHaveBeenNthCalledWith(2,
            expect.objectContaining({ status: 'processing' }),
            expect.objectContaining({ $set: expect.objectContaining({ status: 'completed' }) }),
            expect.objectContaining({ session: null })
        );
        expect(ExecutorGroup.findByIdAndUpdate).toHaveBeenCalledTimes(2);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));

        Transaction.findById.mockResolvedValue({ ...tx, status: 'completed', operatorId: 'employee-1', executorGroupId: 'group-1' });
        await controller.executeViaZaynPay(req, res);
        expect(zaynpay.pay).toHaveBeenCalledTimes(1);
    });
});
