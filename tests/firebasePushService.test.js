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
            data: { transactionId: '123', reminder: 'false' },
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

    test('identifies tokens that Firebase says must be removed', () => {
        expect(isInvalidPushTokenError({ code: 'messaging/registration-token-not-registered' })).toBe(true);
        expect(isInvalidPushTokenError({ code: 'messaging/internal-error' })).toBe(false);
    });
});
