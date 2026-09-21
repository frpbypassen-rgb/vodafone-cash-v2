'use strict';

const Transaction = require('../models/Transaction');
const {
    buildExecutorTaskRecipient,
    stuckAssigneeSlaHint,
    STUCK_ASSIGNEE_SLA_SECONDS,
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

    test('maps routed vs accepted tasks to manager-facing Arabic routing states', () => {
        const routed = toExecutorPortalTaskDto(task({
            assignedExecutorId: 'external-1',
            assignedExecutorName: 'أحمد الخارجي'
        }), 'manager-1');
        expect(routed).toEqual(expect.objectContaining({
            routingState: 'pending_with_assignee',
            routingStateLabel: 'معلّقة عنده',
            assignedExecutorId: 'external-1',
            assignedExecutorName: 'أحمد الخارجي',
            isAssignedToCurrentExecutor: false
        }));

        const assignedToExternal = toExecutorPortalTaskDto(task({
            assignedExecutorId: 'external-1',
            assignedExecutorName: 'أحمد الخارجي'
        }), 'external-1');
        expect(assignedToExternal.isAssignedToCurrentExecutor).toBe(true);
        expect(assignedToExternal.routingStateLabel).toBe('معلّقة عنده');
        expect(assignedToExternal.canClaimThenQuickExecute).toBe(true);
        expect(assignedToExternal.canQuickExecute).toBe(false);
        expect(assignedToExternal.isOwnedByCurrentExecutor).toBe(false);

        const owned = toExecutorPortalTaskDto(task({
            status: 'accepted',
            operatorId: 'employee-1'
        }), 'employee-1');
        expect(owned.canQuickExecute).toBe(true);
        expect(owned.isOwnedByCurrentExecutor).toBe(true);
        expect(owned.canClaimThenQuickExecute).toBe(false);

        const inProgress = toExecutorPortalTaskDto(task({
            status: 'accepted',
            operatorId: 'external-1',
            assignedExecutorId: 'external-1',
            assignedExecutorName: 'أحمد الخارجي',
            executorName: 'أحمد الخارجي'
        }), 'manager-1');
        expect(inProgress).toEqual(expect.objectContaining({
            routingState: 'in_progress',
            routingStateLabel: 'بدأ التنفيذ',
            isAssignedToCurrentExecutor: false
        }));
    });

    test('SLA hint appears only after a routed task stays pending with the assignee', () => {
        const assignedAt = new Date('2026-09-21T12:00:00.000Z');
        expect(stuckAssigneeSlaHint({
            routingState: 'pending_with_assignee',
            assignedExecutorAt: assignedAt,
            now: assignedAt.getTime() + 30 * 1000
        })).toBeNull();

        const stuck = stuckAssigneeSlaHint({
            routingState: 'pending_with_assignee',
            assignedExecutorAt: assignedAt,
            now: assignedAt.getTime() + (STUCK_ASSIGNEE_SLA_SECONDS + 5) * 1000
        });
        expect(stuck).toEqual(expect.objectContaining({
            waitedSeconds: STUCK_ASSIGNEE_SLA_SECONDS + 5
        }));
        expect(stuck.labelAr).toContain('معلّقة عنده');
        expect(stuck.labelAr).toContain('إعادة توجيه');
        expect(stuckAssigneeSlaHint({
            routingState: 'in_progress',
            assignedExecutorAt: assignedAt,
            now: assignedAt.getTime() + 600 * 1000
        })).toBeNull();
    });

    test('raw execution number is private by default in the transaction schema', () => {
        expect(Transaction.schema.path('executorExecutionNumber').options.select).toBe(false);
    });
});
