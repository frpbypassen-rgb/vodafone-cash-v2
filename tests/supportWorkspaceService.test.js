'use strict';

jest.mock('../models/SupportTicket', () => ({}));
jest.mock('../models/Admin', () => ({}));
jest.mock('../models/User', () => ({}));
jest.mock('../models/ClientCompany', () => ({}));
jest.mock('../models/ClientEmployee', () => ({}));
jest.mock('../models/SubAccount', () => ({}));
jest.mock('../models/AgentEmployee', () => ({}));
jest.mock('../models/Employee', () => ({}));
jest.mock('../models/ExecutorGroup', () => ({}));
jest.mock('../models/Transaction', () => ({}));

const {
    computeSupportSla,
    buildTicketFilter,
    serializeTicketSummary,
    assertTicketWritableByAdmin
} = require('../services/supportWorkspaceService');

describe('Support workspace service', () => {
    const admin = { id: 'admin-1', name: 'مدير الدعم', role: 'admin' };

    test('calculates the response countdown from the latest customer waiting time', () => {
        const sla = computeSupportSla({
            status: 'open',
            priority: 'normal',
            createdAt: '2026-08-18T10:00:00.000Z',
            waitingSince: '2026-08-18T10:05:00.000Z',
            lastCustomerMessageAt: '2026-08-18T10:05:00.000Z'
        }, '2026-08-18T10:15:00.000Z');

        expect(sla.awaitingReply).toBe(true);
        expect(sla.responseMinutes).toBe(20);
        expect(sla.responseDueAt.toISOString()).toBe('2026-08-18T10:25:00.000Z');
        expect(sla.remainingMs).toBe(10 * 60 * 1000);
        expect(sla.overdue).toBe(false);
    });

    test('marks an urgent unanswered ticket overdue after five minutes', () => {
        const sla = computeSupportSla({
            status: 'open',
            priority: 'urgent',
            createdAt: '2026-08-18T10:00:00.000Z',
            waitingSince: '2026-08-18T10:00:00.000Z'
        }, '2026-08-18T10:07:00.000Z');

        expect(sla.responseMinutes).toBe(5);
        expect(sla.remainingMs).toBe(-2 * 60 * 1000);
        expect(sla.overdue).toBe(true);
    });

    test('does not keep a response deadline after the ticket is answered', () => {
        const sla = computeSupportSla({
            status: 'answered',
            priority: 'high',
            createdAt: '2026-08-18T10:00:00.000Z',
            lastCustomerMessageAt: '2026-08-18T10:01:00.000Z',
            lastAdminMessageAt: '2026-08-18T10:02:00.000Z'
        }, '2026-08-18T10:03:00.000Z');

        expect(sla.awaitingReply).toBe(false);
        expect(sla.responseDueAt).toBeNull();
        expect(sla.resolutionDueAt).toBeInstanceOf(Date);
    });

    test('builds scoped filters for the current support agent', () => {
        const filter = buildTicketFilter({
            search: 'TCK-123',
            status: 'active',
            priority: 'urgent',
            channel: 'whatsapp',
            assigned: 'mine',
            unread: 'true'
        }, admin);

        expect(filter.status).toEqual({ $in: ['open', 'answered', 'pending_internal'] });
        expect(filter.priority).toBe('urgent');
        expect(filter.channel).toBe('whatsapp');
        expect(filter.assignedToId).toBe('admin-1');
        expect(filter.unreadAdmin).toEqual({ $gt: 0 });
        expect(filter.$or).toHaveLength(5);
        expect(filter.$or[0].ticketId.test('TCK-123')).toBe(true);
    });

    test('reports a live lock held by another administrator', () => {
        const summary = serializeTicketSummary({
            _id: 'ticket-1',
            status: 'open',
            priority: 'normal',
            activeHandlerId: 'admin-2',
            activeHandlerName: 'مدير آخر',
            activeHandlerExpiresAt: '2026-08-18T10:02:00.000Z',
            createdAt: '2026-08-18T10:00:00.000Z'
        }, admin, new Date('2026-08-18T10:01:00.000Z'));

        expect(summary.lock).toMatchObject({ active: true, mine: false, holderId: 'admin-2', holderName: 'مدير آخر' });
    });

    test('blocks concurrent replies but permits writing after the lock expires', () => {
        const liveTicket = {
            activeHandlerId: 'admin-2',
            activeHandlerName: 'مدير آخر',
            activeHandlerExpiresAt: '2026-08-18T10:02:00.000Z'
        };
        expect(() => assertTicketWritableByAdmin(liveTicket, admin, new Date('2026-08-18T10:01:00.000Z')))
            .toThrow('مدير آخر');
        expect(() => assertTicketWritableByAdmin(liveTicket, admin, new Date('2026-08-18T10:03:00.000Z')))
            .not.toThrow();
    });
});
