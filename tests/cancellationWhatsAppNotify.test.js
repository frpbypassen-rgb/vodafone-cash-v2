'use strict';

jest.mock('../services/agencyJournalService', () => ({
    recordTransferReversal: jest.fn().mockResolvedValue(null),
    recordTransferRealization: jest.fn().mockResolvedValue(null)
}));
jest.mock('../services/bullQueueService', () => ({
    addNotificationJob: jest.fn().mockResolvedValue(null)
}));
jest.mock('../services/cancellationReceiptService', () => ({
    attachCancellationReceipt: jest.fn().mockResolvedValue('proofs/CAN-1_cancellation_receipt.jpg')
}));
jest.mock('../services/whatsappReceiptDeliveryService', () => ({
    sendCancelledTransactionReceipt: jest.fn().mockResolvedValue({ success: true }),
    sendCompletedTransactionReceipt: jest.fn()
}));
jest.mock('../services/merchantWebhookService', () => ({
    enqueueTransactionWebhook: jest.fn().mockResolvedValue(null)
}));

const { attachCancellationReceipt } = require('../services/cancellationReceiptService');
const { sendCancelledTransactionReceipt } = require('../services/whatsappReceiptDeliveryService');
const { handleTransferCancelled } = require('../services/eventBus');

describe('cancelled transfer WhatsApp receipt', () => {
    test('sends the cancellation receipt after the receipt is attached', async () => {
        const tx = {
            _id: 'tx-1',
            customId: 'ATT-1',
            userId: '0910000000',
            costLYD: 12.5,
            status: 'cancelled_by_admin',
            cancelledBy: 'الإدارة'
        };

        await handleTransferCancelled({
            tx,
            reason: 'طلب العميل',
            cancellationNumber: 'CAN-1'
        });

        expect(attachCancellationReceipt).toHaveBeenCalledWith(tx, expect.objectContaining({
            reason: 'طلب العميل',
            cancellationNumber: 'CAN-1'
        }));
        expect(sendCancelledTransactionReceipt).toHaveBeenCalledWith(tx);
    });
});
