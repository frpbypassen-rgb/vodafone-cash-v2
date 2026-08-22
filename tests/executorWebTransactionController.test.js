'use strict';

jest.mock('../models/Employee');
jest.mock('../models/Transaction');
jest.mock('../utils/helpers', () => ({ syncBotBalance: jest.fn().mockResolvedValue(0) }));
jest.mock('../services/auditService', () => ({ logAction: jest.fn().mockResolvedValue(true) }));
jest.mock('../services/lockService', () => ({
    acquireLock: jest.fn().mockResolvedValue({ release: jest.fn() }),
    releaseLock: jest.fn().mockResolvedValue(true)
}));
jest.mock('../services/eventBus', () => ({ publish: jest.fn() }));
jest.mock('../utils/receiptGenerator', () => ({
    generateReceiptBase64: jest.fn().mockResolvedValue('data:image/jpeg;base64,AAECAwQ=')
}));
jest.mock('../utils/manualExecutorReceipt', () => ({
    generateManualExecutorReceiptBase64: jest.fn().mockResolvedValue('data:image/jpeg;base64,AAECAwQ='),
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
jest.mock('../services/manualExecutorReceiptReferenceService', () => ({
    reserveManualExecutorReceiptReference: jest.fn().mockResolvedValue({
        prefix: '999',
        sequence: 1,
        reference: '999001'
    })
}));

const fs = require('fs');
const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const { syncBotBalance } = require('../utils/helpers');
const { acquireLock, releaseLock } = require('../services/lockService');
const eventBus = require('../services/eventBus');
const { generateReceiptBase64 } = require('../utils/receiptGenerator');
const { generateManualExecutorReceiptBase64, maskManualExecutionNumber } = require('../utils/manualExecutorReceipt');
const { reserveManualExecutorReceiptReference } = require('../services/manualExecutorReceiptReferenceService');
const controller = require('../controllers/executorTransactionController');

describe('Executor web transaction completion', () => {
    let req;
    let res;
    let tx;

    beforeEach(() => {
        jest.clearAllMocks();
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
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('generates a system receipt when the executor completes without a proof image', async () => {
        await controller.postCompleteTask(req, res);

        expect(Transaction.findOne).toHaveBeenCalledWith(expect.objectContaining({
            _id: 'tx-1',
            status: 'accepted',
            operatorId: 'employee-1'
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
        expect(tx.proofImage).toMatch(/^EXEC-TEST-001_manual_[a-z0-9]+\.jpg$/);
        expect(tx.proofImages).toEqual([tx.proofImage]);
        expect(tx.manualExecutorReceiptReference).toBe('999001');
        expect(tx.adminNotes).toContain('999001');
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
        expect(releaseLock).toHaveBeenCalled();
    });

    test('rejects a task that is not assigned to the current executor', async () => {
        req.body.imageBase64 = 'data:image/png;base64,iVBORw0KGgo=';
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
            imageBase64: 'data:image/png;base64,iVBORw0KGgo=',
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
        expect(tx.executorProofImages[0]).toMatch(/^EXEC-TEST-001_[a-z0-9]+\.png$/);
        expect(tx.executorExecutionNumber).toBe('2258');
        expect(tx.executorExecutionNumberMasked).toBe('01*****2258');
    });

    test('requires a cancellation reason before changing the transaction', async () => {
        await controller.postCancelTask(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ success: false, error: 'سبب الإلغاء مطلوب.' });
        expect(Transaction.findById).not.toHaveBeenCalled();
    });

    test('stores proof, completes once, recalculates balances, and publishes notification', async () => {
        req.body = {
            imageBase64: 'data:image/png;base64,iVBORw0KGgo=',
            imagesBase64: ['data:image/png;base64,iVBORw0KGgo='],
            executionNumber: '01108172258'
        };

        await controller.postCompleteTask(req, res);

        expect(acquireLock).toHaveBeenCalledWith('executor-complete:tx-1', 30000, { retryCount: 1 });
        expect(Transaction.findOne).toHaveBeenCalledWith(expect.objectContaining({
            _id: 'tx-1',
            status: 'accepted',
            operatorId: 'employee-1'
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
        expect(syncBotBalance).toHaveBeenCalledWith('group-1');
        expect(syncBotBalance).toHaveBeenCalledWith('parent-1');
        expect(eventBus.publish).toHaveBeenCalledWith('transfer:completed', { tx, emp: req.executorEmployee });
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
        expect(releaseLock).toHaveBeenCalled();
    });
});
