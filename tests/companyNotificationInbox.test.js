'use strict';

const {
    groupForType,
    hrefForNotification,
    relativeTime,
    presentInbox
} = require('../services/companyNotificationInboxService');

describe('company notification inbox', () => {
    test('groups financial, approval, and system items with deep links', () => {
        const now = new Date('2026-09-19T12:00:00Z');
        const inbox = presentInbox([
            { _id: '1', title: 'تم إتمام التحويل', message: 'اكتملت العملية ATT-1', type: 'transfer_complete', isRead: false, createdAt: new Date('2026-09-19T11:50:00Z') },
            { _id: '2', title: 'رد جديد من الدعم الفني', message: 'لديك رد جديد', type: 'support_reply', isRead: true, createdAt: new Date('2026-09-19T10:00:00Z') },
            { _id: '3', title: 'موافقة مطلوبة', message: 'بانتظار الاعتماد', type: 'approval_needed', isRead: false, createdAt: new Date('2026-09-19T11:00:00Z') }
        ], now);

        expect(groupForType('transfer_complete')).toBe('finance');
        expect(hrefForNotification({ type: 'support_reply' })).toBe('/client/support');
        expect(relativeTime(new Date('2026-09-19T11:50:00Z'), now)).toBe('قبل 10 د');
        expect(inbox.unreadCount).toBe(2);
        expect(inbox.groups.map((group) => group.label)).toEqual(['مالية', 'موافقات', 'نظام']);
        expect(inbox.groups[0].items[0]).toMatchObject({ href: '/client/transactions', isRead: false });
        expect(inbox.groups[1].items).toHaveLength(1);
        expect(inbox.groups[2].items[0].href).toBe('/client/support');
    });
});
