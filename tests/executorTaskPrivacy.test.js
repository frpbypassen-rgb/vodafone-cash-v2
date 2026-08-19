'use strict';

const Transaction = require('../models/Transaction');
const {
    buildExecutorTaskRecipient,
    toExecutorPortalTaskDto
} = require('../utils/executorTaskPrivacy');

const task = (overrides = {}) => ({
    _id: 'task-1',
    customId: 'ATT-2608-2001',
    transferType: 'vodafone',
    amount: 100,
    vodafoneNumber: '01108172258',
    status: 'processing',
    operatorId: null,
    ...overrides
});

describe('executor task recipient privacy', () => {
    test('shows only the first three digits before acceptance', () => {
        const recipient = buildExecutorTaskRecipient(task(), 'employee-1');

        expect(recipient).toEqual({
            recipientNumber: '011',
            recipientPrefix: '011',
            recipientRevealed: false
        });
        expect(JSON.stringify(recipient)).not.toContain('01108172258');
    });

    test('reveals the full number only to the employee who accepted the task', () => {
        const accepted = task({ status: 'accepted', operatorId: 'employee-1' });

        expect(buildExecutorTaskRecipient(accepted, 'employee-1')).toEqual({
            recipientNumber: '01108172258',
            recipientPrefix: '011',
            recipientRevealed: true
        });
        expect(buildExecutorTaskRecipient(accepted, 'employee-2')).toEqual({
            recipientNumber: '011',
            recipientPrefix: '011',
            recipientRevealed: false
        });
    });

    test('portal DTO does not leak nested or alternative full recipient fields', () => {
        const dto = toExecutorPortalTaskDto(task({
            serviceDetails: { recipientPhone: '01099998888' },
            accountNumber: '123456789012345'
        }), 'employee-1');

        expect(dto.recipientNumber).toBe('010');
        expect(dto.vodafoneNumber).toBe('010');
        expect(dto.accountNumber).toBeNull();
        expect(dto).not.toHaveProperty('serviceDetails');
        expect(JSON.stringify(dto)).not.toContain('01099998888');
        expect(JSON.stringify(dto)).not.toContain('123456789012345');
    });

    test('raw execution number is private by default in the transaction schema', () => {
        expect(Transaction.schema.path('executorExecutionNumber').options.select).toBe(false);
    });
});
