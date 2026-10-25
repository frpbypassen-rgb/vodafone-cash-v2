'use strict';
const express = require('express');

const router = express.Router();

const Notification = require('../../models/Notification');

const { resolveClientNotificationUserIds } = require('../../services/clientNotificationService');

const { presentInbox } = require('../../services/companyNotificationInboxService');

const { requireClientAuth } = require('../../middlewares/clientPortalAuth');

router.get('/api/notifications/unread', requireClientAuth, async (req, res) => {
    try {
        const userIds = await resolveClientNotificationUserIds({
            accountType: req.session.accountType,
            clientId: req.session.clientId,
        });

        if (!userIds.length) return res.json({ success: true, count: 0, notifications: [] });

        // تغييرات الأسعار مستبعدة من صندوق الإشعارات وتعرض عبر القناة الحية.
        // لا نحذف سجلات من طلب GET متكرر، لأن ذلك يحول كل تحديث للواجهة إلى كتابة.
        const notifications = await Notification.find({
            userId: { $in: userIds },
            audience: { $in: ['client', 'all'] },
            isRead: false,
            type: { $ne: 'rate_change' },
        })
            .sort({ createdAt: -1 })
            .limit(10)
            .lean();

        const inbox = presentInbox(notifications);
        return res.json({
            success: true,
            count: inbox.unreadCount,
            notifications,
            groups: inbox.groups,
            unreadCount: inbox.unreadCount,
        });
    } catch (_error) {
        return res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
});

router.get('/api/notifications', requireClientAuth, async (req, res) => {
    try {
        const userIds = await resolveClientNotificationUserIds({
            accountType: req.session.accountType,
            clientId: req.session.clientId,
        });
        if (!userIds.length) return res.json(presentInbox([]));
        const notifications = await Notification.find({
            userId: { $in: userIds },
            audience: { $in: ['client', 'all'] },
            type: { $ne: 'rate_change' },
        })
            .sort({ createdAt: -1 })
            .limit(40)
            .lean();
        return res.json(presentInbox(notifications));
    } catch (_error) {
        return res.status(500).json({ success: false, error: 'NOTIFICATION_INBOX_FAILED' });
    }
});

router.post('/api/notifications/:id/read', requireClientAuth, async (req, res) => {
    try {
        const userIds = await resolveClientNotificationUserIds({
            accountType: req.session.accountType,
            clientId: req.session.clientId,
        });

        if (!userIds.length) return res.status(404).json({ success: false });

        const found = await Notification.findOne({
            _id: req.params.id,
            userId: { $in: userIds },
            audience: { $in: ['client', 'all'] },
        })
            .select('_id type metadata')
            .lean();

        if (!found) return res.status(404).json({ success: false });

        const campaignReference = String(found.metadata?.campaignReference || '').trim();
        const filter =
            found.type === 'rate_change' && campaignReference
                ? {
                      userId: { $in: userIds },
                      audience: { $in: ['client', 'all'] },
                      isRead: false,
                      $or: [
                          { _id: found._id },
                          { type: 'rate_change', 'metadata.campaignReference': campaignReference },
                      ],
                  }
                : { _id: found._id, userId: { $in: userIds }, audience: { $in: ['client', 'all'] } };

        await Notification.updateMany(filter, { $set: { isRead: true } });

        return res.json({ success: true });
    } catch (_error) {
        return res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
});

router.post('/api/notifications/read-all', requireClientAuth, async (req, res) => {
    try {
        const userIds = await resolveClientNotificationUserIds({
            accountType: req.session.accountType,
            clientId: req.session.clientId,
        });

        if (userIds.length) {
            await Notification.updateMany(
                {
                    userId: { $in: userIds },
                    audience: { $in: ['client', 'all'] },
                    isRead: false,
                },
                { $set: { isRead: true } }
            );
        }

        return res.json({ success: true });
    } catch (_error) {
        return res.status(500).json({ success: false, error: 'Internal Server Error' });
    }
});

module.exports = router;
