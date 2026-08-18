'use strict';

jest.mock('../models/Admin', () => ({}));
jest.mock('../models/Employee', () => ({}));
jest.mock('../models/ExecutorGroup', () => ({}));
jest.mock('../models/Notification', () => ({}));
jest.mock('../models/SupportTicket', () => ({}));
jest.mock('../models/Transaction', () => ({}));

const {
    allowedCategoriesForRole,
    normalizeCategory,
    normalizePriority,
    buildExecutorTicketScope,
    parseSupportImage,
    serializeTicket
} = require('../services/executorSupportService');

describe('Executor support service', () => {
    test('limits accountant support categories to financial and account concerns', () => {
        const categories = allowedCategoriesForRole('accountant');

        expect(categories).toEqual(expect.arrayContaining(['balance', 'report', 'employee_account']));
        expect(categories).not.toContain('transaction');
        expect(() => normalizeCategory('transaction', 'accountant')).toThrow('غير متاح');
    });

    test('lets a manager access group tickets without exposing another group', () => {
        const employee = {
            _id: '66c000000000000000000001',
            groupId: '66c000000000000000000010',
            role: 'manager'
        };
        const scope = buildExecutorTicketScope(employee);

        expect(scope.entityType).toBe('executor');
        expect(scope.$or).toEqual([
            { entityId: employee._id },
            { 'metadata.executorGroupId': employee.groupId }
        ]);
    });

    test('keeps an operator support scope limited to the current employee', () => {
        const employee = {
            _id: '66c000000000000000000001',
            groupId: '66c000000000000000000010',
            role: 'operator'
        };

        expect(buildExecutorTicketScope(employee)).toEqual({
            entityType: 'executor',
            entityId: employee._id
        });
    });

    test('raises delayed transaction and cancellation requests by default', () => {
        expect(normalizePriority('', 'pending_transaction')).toBe('high');
        expect(normalizePriority('', 'cancellation')).toBe('high');
        expect(normalizePriority('', 'application')).toBe('normal');
        expect(normalizePriority('urgent', 'application')).toBe('urgent');
    });

    test('accepts supported image data and rejects unsupported attachments', () => {
        const jpeg = parseSupportImage(`data:image/jpeg;base64,${Buffer.from('image-bytes').toString('base64')}`);

        expect(jpeg.ext).toBe('jpg');
        expect(jpeg.buffer.toString()).toBe('image-bytes');
        expect(() => parseSupportImage('data:image/gif;base64,AAAA')).toThrow('غير صالحة');
    });

    test('serializes requester, group and linked transaction context for the app', () => {
        const serialized = serializeTicket({
            _id: 'ticket-1',
            ticketId: 'TCK-123456',
            entityId: 'employee-1',
            status: 'answered',
            priority: 'high',
            category: 'transaction',
            unreadUser: 2,
            metadata: {
                subject: 'عملية لا تظهر',
                executorName: 'منفذ تجريبي',
                executorRole: 'operator',
                executorGroupId: 'group-1',
                executorGroupName: 'شركة التنفيذ',
                transaction: { customId: 'ATT-2608-1000' }
            },
            messages: [{ sender: 'admin', text: 'تمت المراجعة' }]
        }, { includeMessages: true });

        expect(serialized.subject).toBe('عملية لا تظهر');
        expect(serialized.requester).toMatchObject({ name: 'منفذ تجريبي', role: 'operator' });
        expect(serialized.group.name).toBe('شركة التنفيذ');
        expect(serialized.transaction.customId).toBe('ATT-2608-1000');
        expect(serialized.unreadCount).toBe(2);
        expect(serialized.messages).toHaveLength(1);
    });
});
