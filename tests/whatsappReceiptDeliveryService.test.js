'use strict';

jest.mock('../models/Transaction', () => ({ findById: jest.fn() }));
jest.mock('../models/User', () => ({ findOne: jest.fn() }));
jest.mock('../models/ClientCompany', () => ({ findById: jest.fn() }));
jest.mock('../models/ClientEmployee', () => ({ findOne: jest.fn() }));
jest.mock('../models/SubAccount', () => ({ findById: jest.fn() }));
jest.mock('../models/AgentEmployee', () => ({ findOne: jest.fn() }));
jest.mock('../models/WhatsAppDelivery', () => {
    const Model = jest.fn().mockImplementation(function Delivery(data) {
        Object.assign(this, data);
        this.save = jest.fn().mockResolvedValue(this);
    });
    Model.findOne = jest.fn();
    return Model;
});
jest.mock('../services/lockService', () => ({ acquireLock: jest.fn(), releaseLock: jest.fn() }));
jest.mock('../services/auditService', () => ({ logAction: jest.fn() }));
jest.mock('../services/receiptShareService', () => ({ createReceiptImageUrl: jest.fn() }));
jest.mock('../services/whatsappService', () => ({
    getWhatChimpConfigurationStatus: jest.fn(),
    normalizeWhatsAppPhone: jest.fn(),
    sendReceipt: jest.fn()
}));

const Transaction = require('../models/Transaction');
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const WhatsAppDelivery = require('../models/WhatsAppDelivery');
const { acquireLock, releaseLock } = require('../services/lockService');
const { createReceiptImageUrl } = require('../services/receiptShareService');
const { getWhatChimpConfigurationStatus, normalizeWhatsAppPhone, sendReceipt } = require('../services/whatsappService');
const {
    sendCompletedTransactionReceipt,
    updateReceiptDeliveryProviderStatus,
    normalizeProviderDeliveryStatus
} = require('../services/whatsappReceiptDeliveryService');

describe('WhatsApp receipt delivery', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        acquireLock.mockResolvedValue({ release: jest.fn() });
        releaseLock.mockResolvedValue(undefined);
        getWhatChimpConfigurationStatus.mockReturnValue({
            receiptReady: true,
            receiptTemplate: 'power_pay_receipt',
            receiptMediaTemplateId: ''
        });
        normalizeWhatsAppPhone.mockReturnValue('201108172258');
        createReceiptImageUrl.mockReturnValue('https://pay.example.test/public/receipt/tx-1/image?signature=signed');
        sendReceipt.mockResolvedValue({ success: true, provider: 'whatchimp', messageId: 'wamid.receipt.1' });
    });

    test('delivers one signed receipt to the transaction owner', async () => {
        const transaction = {
            _id: 'tx-1',
            customId: 'ATT-2608-0001',
            status: 'completed',
            userId: '01108172258',
            employeeName: 'أحمد',
            transferType: 'vodafone',
            amount: 1600,
            proofImage: 'proofs/ATT-2608-0001.jpg',
            completedAt: new Date('2026-08-09T10:00:00.000Z')
        };
        Transaction.findById.mockResolvedValue(transaction);
        User.findOne.mockResolvedValue({ _id: 'user-1', name: 'أحمد', phone: '01108172258' });
        WhatsAppDelivery.findOne.mockResolvedValue(null);

        const result = await sendCompletedTransactionReceipt(transaction);

        expect(result).toMatchObject({ success: true, reference: 'ATT-2608-0001', recipientPhone: '201108172258' });
        expect(sendReceipt).toHaveBeenCalledWith(expect.objectContaining({
            phone: '201108172258',
            reference: 'ATT-2608-0001',
            amount: '1,600',
            receiptUrl: expect.stringContaining('/public/receipt/tx-1/image')
        }));
        expect(WhatsAppDelivery).toHaveBeenCalledTimes(1);
        expect(WhatsAppDelivery.mock.instances[0].status).toBe('sent');
        expect(WhatsAppDelivery.mock.instances[0].messageId).toBe('wamid.receipt.1');
    });

    test('delivers the receipt to the optional client WhatsApp number before the sender account', async () => {
        const transaction = {
            _id: 'tx-client-phone',
            customId: 'ATT-2608-0002',
            status: 'completed',
            userId: '01108172258',
            accountName: 'عميل التحويل',
            transferType: 'vodafone',
            amount: 900,
            proofImage: 'proofs/ATT-2608-0002.jpg',
            serviceDetails: { clientPhone: '0940719000' }
        };
        Transaction.findById.mockResolvedValue(transaction);
        normalizeWhatsAppPhone.mockReturnValue('218940719000');
        WhatsAppDelivery.findOne.mockResolvedValue(null);

        const result = await sendCompletedTransactionReceipt(transaction);

        expect(User.findOne).not.toHaveBeenCalled();
        expect(normalizeWhatsAppPhone).toHaveBeenCalledWith('0940719000');
        expect(sendReceipt).toHaveBeenCalledWith(expect.objectContaining({
            phone: '218940719000',
            accountName: 'عميل التحويل'
        }));
        expect(WhatsAppDelivery.mock.instances[0]).toMatchObject({
            recipientModel: 'TransactionRecipient',
            recipientPhone: '218940719000',
            metadata: expect.objectContaining({ recipientSource: 'client_phone' })
        });
        expect(result).toMatchObject({ success: true, recipientPhone: '218940719000' });
    });
    test('falls back to the company account that created the transfer when no client phone was supplied', async () => {
        const transaction = {
            _id: 'tx-company-sender',
            customId: 'ATT-2608-0003',
            status: 'completed',
            companyId: 'company-1',
            userId: 'company.manager',
            employeeName: 'Account manager',
            transferType: 'vodafone',
            amount: 100,
            proofImage: 'proofs/ATT-2608-0003.jpg'
        };
        Transaction.findById.mockResolvedValue(transaction);
        ClientEmployee.findOne.mockResolvedValue({
            _id: 'employee-1',
            name: 'Account manager',
            phone: '0940719000'
        });
        normalizeWhatsAppPhone.mockReturnValue('218940719000');
        WhatsAppDelivery.findOne.mockResolvedValue(null);

        const result = await sendCompletedTransactionReceipt(transaction);

        expect(ClientEmployee.findOne).toHaveBeenCalledWith(expect.objectContaining({
            companyId: 'company-1',
            $or: [{ phone: 'company.manager' }, { webUsername: 'company.manager' }]
        }));
        expect(ClientCompany.findById).not.toHaveBeenCalled();
        expect(sendReceipt).toHaveBeenCalledWith(expect.objectContaining({
            phone: '218940719000',
            accountName: 'Account manager',
            amount: '100',
            currency: 'ج.م'
        }));
        expect(WhatsAppDelivery.mock.instances[0].metadata).toMatchObject({
            recipientSource: 'account_sender',
            service: 'محافظ كاش'
        });
        expect(result).toMatchObject({ success: true, recipientPhone: '218940719000' });
    });
    test('does not send a duplicate receipt that is already marked as sent', async () => {
        Transaction.findById.mockResolvedValue({ _id: 'tx-2', status: 'completed', userId: '01108172258', proofImage: 'proofs/ATT-2608-0002.jpg' });
        User.findOne.mockResolvedValue({ _id: 'user-1', name: 'أحمد', phone: '01108172258' });
        WhatsAppDelivery.findOne.mockResolvedValue({ status: 'sent', messageId: 'wamid.already.sent' });

        const result = await sendCompletedTransactionReceipt('tx-2');

        expect(result).toMatchObject({ success: true, duplicate: true, code: 'RECEIPT_ALREADY_SENT' });
        expect(sendReceipt).not.toHaveBeenCalled();
    });

    test('waits for receipt generation instead of sending a broken receipt link', async () => {
        Transaction.findById.mockResolvedValue({ _id: 'tx-3', status: 'completed', userId: '01108172258' });
        WhatsAppDelivery.findOne.mockResolvedValue(null);

        const result = await sendCompletedTransactionReceipt('tx-3');

        expect(result).toMatchObject({ success: false, code: 'RECEIPT_PROOF_MISSING' });
        expect(sendReceipt).not.toHaveBeenCalled();
        expect(WhatsAppDelivery.mock.instances[0]).toMatchObject({
            status: 'failed',
            failureCode: 'RECEIPT_PROOF_MISSING'
        });
        expect(WhatsAppDelivery.mock.instances[0].stages).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'receipt_ready', status: 'failed' })
        ]));
    });

    test('records the final WhatsApp delivery status received by webhook', async () => {
        const delivery = {
            status: 'sent',
            messageId: 'wamid.receipt.1',
            metadata: {},
            stages: [],
            save: jest.fn().mockResolvedValue(undefined)
        };
        WhatsAppDelivery.findOne.mockResolvedValue(delivery);

        const result = await updateReceiptDeliveryProviderStatus({
            messageId: 'wamid.receipt.1',
            status: 'delivered',
            rawStatus: 'delivered'
        });

        expect(result.updated).toBe(true);
        expect(delivery.status).toBe('delivered');
        expect(delivery.stages).toEqual(expect.arrayContaining([
            expect.objectContaining({ key: 'provider_delivery', status: 'success' })
        ]));
        expect(normalizeProviderDeliveryStatus('read')).toBe('read');
        expect(normalizeProviderDeliveryStatus('rejected')).toBe('failed');
    });
});
