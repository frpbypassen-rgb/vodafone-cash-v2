'use strict';

jest.mock('../models/Employee', () => ({ findById: jest.fn() }));
jest.mock('../models/Transaction', () => ({ findById: jest.fn() }));
jest.mock('../models/Admin', () => ({}));
jest.mock('../controllers/executorSupportController', () => ({}));
jest.mock('../services/executorTaskRoutingService', () => ({ acceptExecutorTask: jest.fn() }));
jest.mock('../services/executorTransactionMutationService', () => ({
    editExecutorAmount: jest.fn(), cancelExecutorTask: jest.fn(), returnExecutorTask: jest.fn()
}));
jest.mock('../services/executorCompletionService', () => ({ completeExecutorTask: jest.fn() }));
jest.mock('../services/executorProviderExecutionService', () => ({ executeExecutorProviderTask: jest.fn() }));
jest.mock('../services/executorCancellationNotificationService', () => ({ notifyExecutorCancellation: jest.fn() }));
jest.mock('../services/executorProofStorageService', () => ({ MAX_PROOF_IMAGES: 6 }));
jest.mock('../services/splitPartProofService', () => ({ retrySplitPartProof: jest.fn() }));
jest.mock('../utils/logger', () => ({ error: jest.fn() }));

const Employee = require('../models/Employee');
const Transaction = require('../models/Transaction');
const { retrySplitPartProof } = require('../services/splitPartProofService');
const { completeExecutorTask } = require('../services/executorCompletionService');
const { executeExecutorProviderTask } = require('../services/executorProviderExecutionService');
const mutations = require('../services/executorTransactionMutationService');
const logger = require('../utils/logger');
const controller = require('../controllers/executorTransactionController');

describe.each(['postRetryPartProof', 'postRateExecutor', 'postVoiceNote'])(
    'Executor task ownership: %s', (handler) => {
        let req;
        let res;
        let tx;

        beforeEach(() => {
            jest.resetAllMocks();
            req = {
                params: { id: 'tx-1', partId: 'part-1' },
                session: { executorId: 'employee-1' },
                executorEmployee: { _id: 'employee-1', groupId: { _id: 'group-1' } },
                body: { rating: 4, note: ' review ', base64: 'data:audio/webm;base64,AAEC' }
            };
            res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
            tx = {
                _id: 'tx-1', executorGroupId: 'group-1', managerGroupId: 'manager-1',
                amount: 250, costLYD: 12.5, status: 'accepted', operatorId: 'employee-1',
                save: jest.fn().mockResolvedValue(true)
            };
            Transaction.findById.mockResolvedValue(tx);
            Employee.findById.mockResolvedValue(req.executorEmployee);
            retrySplitPartProof.mockResolvedValue({ ok: true, code: 'RETRIED', partId: 'part-1' });
        });

        afterEach(() => {
            expect(tx).toMatchObject({ amount: 250, costLYD: 12.5, status: 'accepted', operatorId: 'employee-1' });
            expect(completeExecutorTask).not.toHaveBeenCalled();
            expect(executeExecutorProviderTask).not.toHaveBeenCalled();
            Object.values(mutations).forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
        });

        const expectNoMutation = () => {
            expect(tx.save).not.toHaveBeenCalled();
            expect(retrySplitPartProof).not.toHaveBeenCalled();
            expect(tx.executorRating).toBeUndefined();
            expect(tx.voiceNote).toBeUndefined();
        };

        const expectAllowed = () => {
            expect(res.json).toHaveBeenCalledTimes(1);
            expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
            if (handler === 'postRetryPartProof') {
                expect(retrySplitPartProof).toHaveBeenCalledWith('tx-1', 'part-1');
                expect(tx.save).not.toHaveBeenCalled();
            } else {
                expect(tx.save).toHaveBeenCalledTimes(1);
                if (handler === 'postRateExecutor') {
                    expect(tx.executorRating).toBe(4);
                    expect(tx.executorRatingNote).toBe('review');
                } else {
                    expect(tx.voiceNote).toBe(req.body.base64);
                }
            }
        };

        test('returns 404 before loading an employee for a missing task', async () => {
            delete req.executorEmployee;
            Transaction.findById.mockResolvedValue(null);
            await controller[handler](req, res);
            expect(res.status).toHaveBeenCalledWith(404);
            expect(res.json).toHaveBeenCalledWith({ success: false, error: 'العملية غير موجودة.' });
            expect(Employee.findById).not.toHaveBeenCalled();
            expectNoMutation();
        });

        test('returns 401 when the employee cannot be found', async () => {
            delete req.executorEmployee;
            Employee.findById.mockResolvedValue(null);
            await controller[handler](req, res);
            expect(Employee.findById).toHaveBeenCalledWith('employee-1');
            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Unauthorized' });
            expectNoMutation();
        });

        test('returns 403 without changing a task in another group', async () => {
            tx.executorGroupId = 'foreign-group';
            tx.managerGroupId = 'foreign-manager';
            await controller[handler](req, res);
            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Forbidden' });
            expectNoMutation();
        });

        test.each(['executorGroupId', 'managerGroupId'])(
            'allows a task owned through %s with populated IDs', async (groupField) => {
                tx.executorGroupId = 'foreign-group';
                tx.managerGroupId = 'foreign-manager';
                tx[groupField] = { _id: { toString: () => 'group-1' } };
                await controller[handler](req, res);
                expect(Transaction.findById).toHaveBeenCalledWith('tx-1');
                expect(Employee.findById).not.toHaveBeenCalled();
                expectAllowed();
            }
        );

        test('loads the employee once when middleware has not attached it', async () => {
            delete req.executorEmployee;
            Employee.findById.mockResolvedValue({ _id: 'employee-1', groupId: 'group-1' });
            await controller[handler](req, res);
            expect(Employee.findById).toHaveBeenCalledTimes(1);
            expect(Employee.findById).toHaveBeenCalledWith('employee-1');
            expectAllowed();
        });

        test.each(['task', 'employee'])(
            'keeps a safe 500 response when the %s lookup fails', async (lookup) => {
                const error = new Error('mongodb://user:secret@internal-host');
                if (lookup === 'task') Transaction.findById.mockRejectedValue(error);
                else {
                    delete req.executorEmployee;
                    Employee.findById.mockRejectedValue(error);
                }
                await controller[handler](req, res);
                expect(res.status).toHaveBeenCalledWith(500);
                expect(res.json).toHaveBeenCalledTimes(1);
                expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
                expect(JSON.stringify(res.json.mock.calls)).not.toContain('secret');
                expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret');
                expectNoMutation();
            }
        );
    }
);
