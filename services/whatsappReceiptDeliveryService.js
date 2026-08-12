'use strict';

const Transaction = require('../models/Transaction');
const User = require('../models/User');
const ClientCompany = require('../models/ClientCompany');
const ClientEmployee = require('../models/ClientEmployee');
const SubAccount = require('../models/SubAccount');
const AgentEmployee = require('../models/AgentEmployee');
const WhatsAppDelivery = require('../models/WhatsAppDelivery');
const { acquireLock, releaseLock } = require('./lockService');
const { logAction } = require('./auditService');
const { createReceiptImageUrl } = require('./receiptShareService');
const {
    getWhatChimpConfigurationStatus,
    normalizeWhatsAppPhone,
    sendReceipt
} = require('./whatsappService');

const RECEIPT_DELIVERY_STATUSES = new Set(['sent', 'delivered', 'read']);

const serviceLabel = (transferType) => ({
    vodafone: 'محافظ كاش',
    post_account: 'بريد حساب',
    post_card: 'بريد بطاقة',
    bank_account: 'حساب بنكي',
    sefa_niger: 'سيفا النيجر',
    bankak_sudan: 'بنكك السودان'
}[String(transferType || '').trim()] || 'محافظ كاش');

const receiptCurrency = (transaction) => (
    transaction?.transferType === 'sefa_niger'
        ? 'سيفا'
        : (transaction?.serviceDetails?.amountCurrency === 'SDG' ? 'ج.س' : 'ج.م')
);

const formatReceiptAmount = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return String(value || '---');
    return new Intl.NumberFormat('en-US', {
        minimumFractionDigits: Number.isInteger(numeric) ? 0 : 2,
        maximumFractionDigits: 2
    }).format(numeric);
};

const safelyFind = async (operation) => {
    try {
        return await operation();
    } catch (_) {
        return null;
    }
};

const findCompanyTransferSender = async (transaction) => {
    const userId = String(transaction.userId || '').trim();
    if (!transaction.companyId || !userId) return null;

    return safelyFind(() => ClientEmployee.findOne({
        companyId: transaction.companyId,
        $or: [{ phone: userId }, { webUsername: userId }]
    }));
};

const findCompanyManager = async (transaction) => {
    if (!transaction.companyId) return null;

    return safelyFind(() => ClientEmployee.findOne({
        companyId: transaction.companyId,
        phone: { $exists: true, $nin: ['', null] },
        $or: [
            { role: 'owner' },
            { canManageCompany: true },
            { canCreateCompanyStaff: true }
        ]
    }));
};

const resolveReceiptRecipient = async (transaction) => {
    if (!transaction) return null;

    // Prefer the optional end-customer WhatsApp number saved with the transfer.
    const clientPhone = String(transaction.serviceDetails?.clientPhone || '').trim();
    if (clientPhone) {
        return {
            phone: clientPhone,
            name: transaction.accountName || 'عميل العملية',
            model: 'TransactionRecipient',
            id: null,
            source: 'client_phone'
        };
    }

    if (transaction.subAccountId) {
        const account = await safelyFind(() => SubAccount.findById(transaction.subAccountId));
        if (account?.phone) {
            return { phone: account.phone, name: account.name || transaction.subAccountName || '', model: 'SubAccount', id: account._id, source: 'account' };
        }
    }

    if (transaction.companyId) {
        // The staff account that created the transfer is the company fallback recipient.
        const sender = await findCompanyTransferSender(transaction);
        if (sender?.phone) {
            return {
                phone: sender.phone,
                name: sender.name || transaction.employeeName || '',
                model: 'ClientEmployee',
                id: sender._id,
                source: 'account_sender'
            };
        }

        const manager = await findCompanyManager(transaction);
        if (manager?.phone) {
            return {
                phone: manager.phone,
                name: manager.name || transaction.companyName || '',
                model: 'ClientEmployee',
                id: manager._id,
                source: 'company_manager'
            };
        }

        const company = await safelyFind(() => ClientCompany.findById(transaction.companyId));
        if (company?.phone) {
            return { phone: company.phone, name: company.name || transaction.companyName || '', model: 'ClientCompany', id: company._id, source: 'company_account' };
        }
    }

    const userId = String(transaction.userId || '').trim();
    if (userId) {
        const user = await safelyFind(() => User.findOne({ $or: [{ phone: userId }, { webUsername: userId }] }));
        if (user?.phone) {
            return { phone: user.phone, name: user.name || transaction.employeeName || '', model: 'User', id: user._id, source: 'account' };
        }

        const employee = await safelyFind(() => AgentEmployee.findOne({ $or: [{ phone: userId }, { webUsername: userId }] }));
        if (employee?.phone) {
            return { phone: employee.phone, name: employee.name || transaction.employeeName || '', model: 'AgentEmployee', id: employee._id, source: 'account' };
        }

        return { phone: userId, name: transaction.employeeName || '', model: 'Unknown', id: null, source: 'account' };
    }

    return null;
};

const saveDelivery = async (delivery) => {
    try {
        await delivery.save();
    } catch (error) {
        if (error?.code !== 11000) throw error;
    }
};

const logReceiptDelivery = async ({ success, transaction, recipient, result }) => {
    await logAction({
        action: success ? 'WHATSAPP_RECEIPT_SENT' : 'WHATSAPP_RECEIPT_FAILED',
        targetId: transaction?._id,
        targetModel: 'Transaction',
        performedByModel: 'System',
        performedByName: 'WhatChimp',
        success,
        errorCode: success ? undefined : result?.code,
        metadata: {
            customId: transaction?.customId,
            recipientModel: recipient?.model,
            recipientPhone: recipient?.phone,
            recipientSource: recipient?.source || 'account',
            provider: result?.provider || 'whatchimp',
            messageId: result?.messageId || null,
            templateName: result?.templateName || null
        }
    });
};

const sendCompletedTransactionReceipt = async (transactionInput) => {
    const transactionId = String(transactionInput?._id || transactionInput || '').trim();
    if (!transactionId) {
        return { success: false, code: 'TRANSACTION_REQUIRED', message: 'تعذر تحديد العملية لإرسال الإيصال.' };
    }

    let lock;
    try {
        lock = await acquireLock(`whatsapp-receipt:${transactionId}`, 30000, { retryCount: 1, retryDelay: 25 });
    } catch (error) {
        return { success: false, code: 'RECEIPT_DELIVERY_BUSY', message: 'إرسال الإيصال قيد المعالجة بالفعل.' };
    }

    try {
        const transaction = await Transaction.findById(transactionId);
        if (!transaction || transaction.status !== 'completed') {
            return { success: false, code: 'RECEIPT_NOT_AVAILABLE', message: 'الإيصال متاح للعمليات الناجحة فقط.' };
        }
        const receiptProofs = [
            ...(Array.isArray(transaction.proofImages) ? transaction.proofImages : []),
            transaction.proofImage
        ].filter(Boolean);
        if (!receiptProofs.length) {
            return { success: false, code: 'RECEIPT_PROOF_MISSING', message: 'لم يتم توليد صورة إيصال لهذه العملية بعد.' };
        }

        const configuration = getWhatChimpConfigurationStatus();
        if (!configuration.receiptReady) {
            return {
                success: false,
                code: 'WHATCHIMP_RECEIPT_NOT_READY',
                message: 'إعداد قالب إيصال WhatChimp غير مكتمل.',
                missing: configuration.missing
            };
        }

        const recipient = await resolveReceiptRecipient(transaction);
        if (!recipient?.phone) {
            return { success: false, code: 'RECEIPT_RECIPIENT_MISSING', message: 'لا يوجد رقم واتساب صالح لصاحب العملية.' };
        }

        let normalizedPhone;
        try {
            normalizedPhone = normalizeWhatsAppPhone(recipient.phone);
        } catch (error) {
            return { success: false, code: error.code || 'WHATSAPP_PHONE_INVALID', message: error.message };
        }

        const existing = await WhatsAppDelivery.findOne({
            kind: 'receipt',
            transactionId: transaction._id,
            recipientPhone: normalizedPhone
        });
        if (existing && RECEIPT_DELIVERY_STATUSES.has(existing.status)) {
            return {
                success: true,
                duplicate: true,
                code: 'RECEIPT_ALREADY_SENT',
                messageId: existing.messageId || null,
                message: 'تم إرسال إيصال هذه العملية مسبقاً.'
            };
        }

        const receiptUrl = createReceiptImageUrl({ transactionId: transaction._id, index: 0 });
        if (!receiptUrl) {
            const failure = {
                success: false,
                provider: 'whatchimp',
                code: 'RECEIPT_PUBLIC_URL_UNAVAILABLE',
                message: 'أضف PUBLIC_APP_URL و RECEIPT_SHARE_SECRET لإرسال إيصالات واتساب.'
            };
            if (existing) {
                existing.status = 'failed';
                existing.failureCode = failure.code;
                existing.failureReason = failure.message;
                await saveDelivery(existing);
            }
            await logReceiptDelivery({ success: false, transaction, recipient, result: failure });
            return failure;
        }

        const delivery = existing || new WhatsAppDelivery({
            kind: 'receipt',
            transactionId: transaction._id,
            recipientPhone: normalizedPhone
        });
        delivery.provider = 'whatchimp';
        delivery.recipientName = recipient.name || '';
        delivery.recipientModel = recipient.model || '';
        delivery.recipientId = recipient.id || null;
        delivery.reference = transaction.customId || '';
        delivery.templateName = configuration.receiptTemplate || '';
        delivery.templateId = configuration.receiptMediaTemplateId || '';
        delivery.status = 'sending';
        delivery.failureCode = '';
        delivery.failureReason = '';
        delivery.metadata = {
            service: serviceLabel(transaction.transferType),
            receiptUrl,
            proofIndex: 0,
            recipientSource: recipient.source || 'account'
        };
        await saveDelivery(delivery);

        const result = await sendReceipt({
            phone: normalizedPhone,
            accountName: recipient.name || transaction.employeeName || transaction.companyName || '',
            reference: transaction.customId || String(transaction._id),
            amount: formatReceiptAmount(transaction.amount),
            currency: receiptCurrency(transaction),
            completedAt: transaction.completedAt || transaction.updatedAt || new Date(),
            receiptUrl
        });

        delivery.status = result.success ? 'sent' : 'failed';
        delivery.messageId = result.messageId || '';
        delivery.failureCode = result.success ? '' : (result.code || 'WHATCHIMP_REQUEST_FAILED');
        delivery.failureReason = result.success ? '' : (result.message || 'تعذر إرسال إيصال واتساب.');
        delivery.sentAt = result.success ? new Date() : undefined;
        await saveDelivery(delivery);
        await logReceiptDelivery({ success: result.success, transaction, recipient, result });

        return {
            ...result,
            transactionId: String(transaction._id),
            reference: transaction.customId,
            recipientPhone: normalizedPhone
        };
    } catch (error) {
        return {
            success: false,
            code: 'RECEIPT_DELIVERY_FAILED',
            message: error.message || 'تعذر إرسال إيصال واتساب.'
        };
    } finally {
        await releaseLock(lock);
    }
};

module.exports = {
    resolveReceiptRecipient,
    findCompanyTransferSender,
    findCompanyManager,
    sendCompletedTransactionReceipt
};
