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

const fs = require('fs');
const Transaction = require('../models/Transaction');
const { syncBotBalance } = require('../utils/helpers');
const { acquireLock, releaseLock } = require('../services/lockService');
const eventBus = require('../services/eventBus');
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
            notes: 'ملاحظة العميل',
            save: jest.fn().mockResolvedValue(true)
        };
        Transaction.findOne.mockResolvedValue(tx);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('requires a proof image before completing the task', async () => {
        await controller.postCompleteTask(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            success: false,
            error: expect.stringContaining('إرفاق صورة')
        }));
        expect(Transaction.findOne).not.toHaveBeenCalled();
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

    test('stores proof, completes once, recalculates balances, and publishes notification', async () => {
        req.body = {
            imageBase64: 'data:image/png;base64,iVBORw0KGgo=',
            imagesBase64: ['data:image/png;base64,iVBORw0KGgo='],
            senderPhone: '01000000000'
        };

        await controller.postCompleteTask(req, res);

        expect(acquireLock).toHaveBeenCalledWith('executor-complete:tx-1', 30000, { retryCount: 1 });
        expect(Transaction.findOne).toHaveBeenCalledWith(expect.objectContaining({
            _id: 'tx-1',
            status: 'accepted',
            operatorId: 'employee-1'
        }));
        expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
        expect(tx.status).toBe('completed');
        expect(tx.proofImage).toMatch(/EXEC-TEST-001_.+\.png$/);
        expect(tx.proofImages).toHaveLength(1);
        expect(tx.executorSenderPhone).toBe('01000000000');
        expect(tx.save).toHaveBeenCalledTimes(1);
        expect(syncBotBalance).toHaveBeenCalledWith('group-1');
        expect(syncBotBalance).toHaveBeenCalledWith('parent-1');
        expect(eventBus.publish).toHaveBeenCalledWith('transfer:completed', { tx, emp: req.executorEmployee });
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
        expect(releaseLock).toHaveBeenCalled();
    });
});
