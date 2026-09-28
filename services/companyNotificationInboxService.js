'use strict';

const GROUP_META = Object.freeze({
    finance: { key: 'finance', label: 'مالية' },
    approvals: { key: 'approvals', label: 'موافقات' },
    system: { key: 'system', label: 'نظام' }
});

const TYPE_GROUP = Object.freeze({
    deposit: 'finance',
    deduction: 'finance',
    transfer: 'finance',
    transfer_complete: 'finance',
    low_balance: 'finance',
    approval: 'approvals',
    approval_needed: 'approvals',
    corporate_approval: 'approvals',
    support_reply: 'system',
    system_alert: 'system',
    rate_change: 'system'
});

const TYPE_HREF = Object.freeze({
    deposit: '/client/finance',
    deduction: '/client/finance',
    transfer: '/client/transactions',
    transfer_complete: '/client/transactions',
    low_balance: '/client/company/deposits',
    approval: '/client/transactions',
    approval_needed: '/client/transactions',
    support_reply: '/client/support',
    system_alert: '/client/services'
});

const groupForType = (type) => TYPE_GROUP[String(type || '').toLowerCase()] || 'system';

const hrefForNotification = (notification = {}) => {
    const metadataHref = String(notification.metadata?.href || notification.metadata?.url || '').trim();
    if (metadataHref.startsWith('/client/')) return metadataHref;
    if (notification.txId) return '/client/transactions';
    return TYPE_HREF[String(notification.type || '').toLowerCase()] || '/client/services';
};

const relativeTime = (value, now = new Date()) => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return 'الآن';
    const delta = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
    if (delta < 45) return 'الآن';
    if (delta < 3600) return `قبل ${Math.max(1, Math.floor(delta / 60))} د`;
    if (delta < 86400) return `قبل ${Math.max(1, Math.floor(delta / 3600))} س`;
    const days = Math.floor(delta / 86400);
    if (days < 7) return `قبل ${days} ي`;
    return date.toLocaleDateString('ar-LY', { timeZone: 'Africa/Tripoli', day: 'numeric', month: 'short' });
};

const presentNotification = (notification, now = new Date()) => {
    const group = groupForType(notification.type);
    return {
        id: String(notification._id || ''),
        title: String(notification.title || 'تنبيه'),
        message: String(notification.message || '').replace(/\s+/g, ' ').trim(),
        type: String(notification.type || 'system_alert'),
        group,
        groupLabel: GROUP_META[group].label,
        href: hrefForNotification(notification),
        isRead: notification.isRead === true,
        createdAt: notification.createdAt || null,
        relativeTime: relativeTime(notification.createdAt, now),
        txId: notification.txId || ''
    };
};

const emptyGroups = () => ({
    finance: [],
    approvals: [],
    system: []
});

const presentInbox = (notifications = [], now = new Date()) => {
    const items = notifications.map((row) => presentNotification(row, now));
    const groups = emptyGroups();
    items.forEach((item) => {
        if (groups[item.group]) groups[item.group].push(item);
    });
    const unreadCount = items.filter((item) => !item.isRead).length;
    return {
        success: true,
        count: unreadCount,
        unreadCount,
        notifications: items,
        groups: [
            { ...GROUP_META.finance, items: groups.finance },
            { ...GROUP_META.approvals, items: groups.approvals },
            { ...GROUP_META.system, items: groups.system }
        ]
    };
};

module.exports = {
    GROUP_META,
    groupForType,
    hrefForNotification,
    relativeTime,
    presentNotification,
    presentInbox
};
