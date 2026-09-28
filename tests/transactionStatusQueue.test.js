'use strict';

const {
    FAILED_STATUSES,
    IN_PROGRESS_STATUSES,
    PENDING_STATUSES,
    SUCCESS_STATUSES,
    TRANSACTION_STATUS_QUEUE_DEFAULT_ORDER,
    TRANSACTION_STATUS_QUEUE_ORDER,
    sortTransactionsByStatusQueue,
    transactionStatusQueueAddFieldsStage,
    transactionStatusQueueOrder,
    transactionStatusQueuePipelineStages
} = require('../utils/transactionStatusQueue');

const row = (status, createdAt, id) => ({
    _id: id,
    status,
    createdAt: new Date(createdAt)
});

describe('transaction status queue order', () => {
    test('maps statuses into pending → in progress → success → failed groups', () => {
        expect(PENDING_STATUSES).toEqual(['pending', 'deposit_pending']);
        expect(IN_PROGRESS_STATUSES).toEqual(['processing', 'accepted']);
        expect(SUCCESS_STATUSES).toEqual(['completed', 'deposit', 'deduction']);
        expect(FAILED_STATUSES).toEqual(expect.arrayContaining(['rejected', 'cancelled_by_admin']));

        expect(transactionStatusQueueOrder('pending')).toBe(0);
        expect(transactionStatusQueueOrder('deposit_pending')).toBe(0);
        expect(transactionStatusQueueOrder('processing')).toBe(1);
        expect(transactionStatusQueueOrder('accepted')).toBe(1);
        expect(transactionStatusQueueOrder('completed')).toBe(2);
        expect(transactionStatusQueueOrder('deposit')).toBe(2);
        expect(transactionStatusQueueOrder('deduction')).toBe(2);
        expect(transactionStatusQueueOrder('rejected')).toBe(3);
        expect(transactionStatusQueueOrder('cancelled_by_admin')).toBe(3);
        expect(transactionStatusQueueOrder('unknown')).toBe(TRANSACTION_STATUS_QUEUE_DEFAULT_ORDER);
        expect(transactionStatusQueueOrder('completed')).toBeGreaterThan(transactionStatusQueueOrder('accepted'));
    });

    test('keeps pending and in-progress above successful rows, then failed/cancelled', () => {
        const sorted = sortTransactionsByStatusQueue([
            row('completed', '2026-09-19T12:00:00.000Z', 'done-new'),
            row('rejected', '2026-09-19T12:05:00.000Z', 'fail-new'),
            row('pending', '2026-09-19T10:00:00.000Z', 'wait-old'),
            row('accepted', '2026-09-19T11:30:00.000Z', 'work-new'),
            row('deposit', '2026-09-19T12:10:00.000Z', 'deposit-new'),
            row('processing', '2026-09-19T11:00:00.000Z', 'work-old'),
            row('deposit_pending', '2026-09-19T11:45:00.000Z', 'wait-new'),
            row('cancelled_by_admin', '2026-09-19T09:00:00.000Z', 'fail-old'),
            row('deduction', '2026-09-19T08:00:00.000Z', 'deduct-old')
        ]);

        expect(sorted.map((tx) => tx._id)).toEqual([
            'wait-new',
            'wait-old',
            'work-new',
            'work-old',
            'deposit-new',
            'done-new',
            'deduct-old',
            'fail-new',
            'fail-old'
        ]);
        expect(sorted.map((tx) => tx.status)).toEqual([
            'deposit_pending',
            'pending',
            'accepted',
            'processing',
            'deposit',
            'completed',
            'deduction',
            'rejected',
            'cancelled_by_admin'
        ]);
    });

    test('sorts newest first inside the same status group', () => {
        const sorted = sortTransactionsByStatusQueue([
            row('pending', '2026-09-19T08:00:00.000Z', 'p-old'),
            row('pending', '2026-09-19T09:00:00.000Z', 'p-new'),
            row('accepted', '2026-09-19T08:30:00.000Z', 'a-old'),
            row('processing', '2026-09-19T09:30:00.000Z', 'proc-new'),
            row('completed', '2026-09-19T07:00:00.000Z', 'c-old'),
            row('completed', '2026-09-19T10:00:00.000Z', 'c-new')
        ]);

        expect(sorted.map((tx) => tx._id)).toEqual([
            'p-new',
            'p-old',
            'proc-new',
            'a-old',
            'c-new',
            'c-old'
        ]);
    });

    test('builds Mongo stages that match the in-memory priority groups', () => {
        const addFields = transactionStatusQueueAddFieldsStage();
        const branches = addFields.$addFields.operationQueueOrder.$switch.branches;
        const byOrder = Object.fromEntries(branches.map((branch) => [branch.then, branch.case.$in[1]]));

        expect(byOrder[0]).toEqual([...PENDING_STATUSES]);
        expect(byOrder[1]).toEqual([...IN_PROGRESS_STATUSES]);
        expect(byOrder[2]).toEqual([...SUCCESS_STATUSES]);
        expect(byOrder[3]).toEqual([...FAILED_STATUSES]);
        expect(addFields.$addFields.operationQueueOrder.$switch.default).toBe(TRANSACTION_STATUS_QUEUE_DEFAULT_ORDER);

        Object.entries(TRANSACTION_STATUS_QUEUE_ORDER).forEach(([status, order]) => {
            const group = branches.find((branch) => branch.then === order);
            expect(group.case.$in[1]).toContain(status);
        });

        expect(transactionStatusQueuePipelineStages({ skip: 100, limit: 50 })).toEqual([
            addFields,
            { $sort: { operationQueueOrder: 1, createdAt: -1, _id: -1 } },
            { $skip: 100 },
            { $limit: 50 },
            { $project: { operationQueueOrder: 0 } }
        ]);
    });

    test('keeps cancelled operations in the operations timeline beside successes', () => {
        const sorted = sortTransactionsByStatusQueue([
            row('completed', '2026-09-19T12:00:00.000Z', 'done-mid'),
            row('cancelled_by_admin', '2026-09-19T12:05:00.000Z', 'cancel-new'),
            row('pending', '2026-09-19T10:00:00.000Z', 'wait-old'),
            row('completed', '2026-09-19T12:10:00.000Z', 'done-new'),
            row('rejected', '2026-09-19T11:30:00.000Z', 'reject-mid'),
            row('accepted', '2026-09-19T09:00:00.000Z', 'work-old')
        ], 'operations');

        expect(sorted.map((tx) => tx._id)).toEqual([
            'wait-old',
            'work-old',
            'done-new',
            'cancel-new',
            'done-mid',
            'reject-mid'
        ]);
        expect(transactionStatusQueueOrder('cancelled_by_admin', 'operations'))
            .toBe(transactionStatusQueueOrder('completed', 'operations'));
        expect(transactionStatusQueueOrder('cancelled_by_admin')).toBe(3);
    });
});
