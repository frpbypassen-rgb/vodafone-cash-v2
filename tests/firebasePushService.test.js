'use strict';

const {
    isInvalidPushTokenError,
    resetFirebasePushForTests,
    sendPushToTokens,
    setMessagingClientForTests
} = require('../services/firebasePushService');

describe('firebase push service', () => {
    afterEach(() => {
        resetFirebasePushForTests();
    });

    test('sends high-priority task data through the executor notification channel', async () => {
        const client = {
            sendEachForMulticast: jest.fn().mockResolvedValue({
                successCount: 1,
                failureCount: 0,
                responses: [{ success: true, messageId: 'message-1' }]
            })
        };
        setMessagingClientForTests(client);

        const result = await sendPushToTokens({
            tokens: ['token-1', 'token-1'],
            title: 'وصل طلب تنفيذ جديد',
            body: '01108172258 | 100',
            data: { transactionId: 123, reminder: false },
            visible: true,
            channelId: 'executor_tasks',
            collapseKey: 'executor-task-123'
        });

        expect(result.successCount).toBe(1);
        expect(client.sendEachForMulticast).toHaveBeenCalledTimes(1);
        expect(client.sendEachForMulticast).toHaveBeenCalledWith(expect.objectContaining({
            tokens: ['token-1'],
            data: expect.objectContaining({
                transactionId: '123',
                reminder: 'false',
                channelId: 'executor_tasks',
                sound: 'default',
                notificationTitle: 'وصل طلب تنفيذ جديد',
                notificationBody: '01108172258 | 100'
            }),
            notification: {
                title: 'وصل طلب تنفيذ جديد',
                body: '01108172258 | 100'
            },
            android: expect.objectContaining({
                priority: 'high',
                collapseKey: 'executor-task-123',
                notification: expect.objectContaining({ channelId: 'executor_tasks', sound: 'default' })
            })
        }));
    });

    test('sends Android data-only payloads so the app can select a custom sound', async () => {
        const client = {
            sendEachForMulticast: jest.fn().mockResolvedValue({
                successCount: 1,
                failureCount: 0,
                responses: [{ success: true, messageId: 'message-2' }]
            })
        };
        setMessagingClientForTests(client);

        await sendPushToTokens({
            tokens: ['token-2'],
            title: 'إنذار عاجل',
            body: 'راجع العملية الآن',
            data: { category: 'executor_urgent_alert' },
            visible: true,
            channelId: 'executor_urgent_alerts_v2',
            sound: 'ahram_urgent_alarm',
            androidDataOnly: true
        });

        const message = client.sendEachForMulticast.mock.calls[0][0];
        expect(message.notification).toBeUndefined();
        expect(message.android.notification).toBeUndefined();
        expect(message.android.priority).toBe('high');
        expect(message.data).toEqual(expect.objectContaining({
            category: 'executor_urgent_alert',
            channelId: 'executor_urgent_alerts_v2',
            sound: 'ahram_urgent_alarm',
            notificationTitle: 'إنذار عاجل',
            notificationBody: 'راجع العملية الآن'
        }));
    });

    test('identifies tokens that Firebase says must be removed', () => {
        expect(isInvalidPushTokenError({ code: 'messaging/registration-token-not-registered' })).toBe(true);
        expect(isInvalidPushTokenError({ code: 'messaging/internal-error' })).toBe(false);
    });
});
