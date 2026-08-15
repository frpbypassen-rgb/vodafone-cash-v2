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

const DELIVERY_STAGE_LABELS = {
    transaction_verified: 'التحقق من نجاح العملية',
    receipt_ready: 'التحقق من صورة الإيصال',
    configuration_verified: 'التحقق من إعدادات WhatChimp',
    recipient_resolved: 'تحديد رقم مستلم الإيصال',
    phone_normalized: 'تجهيز رقم واتساب',
    receipt_link_ready: 'إنشاء رابط الإيصال',
    provider_request: 'إرسال الطلب إلى WhatChimp',
    provider_acceptance: 'قبول الرسالة من WhatChimp',
    provider_delivery: 'تأكيد التسليم إلى واتساب',
    rate_change_prepared: 'تجهيز تفاصيل تغيير السعر',
    rate_change_configuration: 'التحقق من قالب تغيير السعر'
};

const markDeliveryStage = (delivery, key, status, detail = '') => {
    const stages = Array.isArray(delivery.stages) ? [...delivery.stages] : [];
    const stage = {
        key,
        label: DELIVERY_STAGE_LABELS[key] || key,
        status,
        detail: String(detail || '').slice(0, 1000),
        occurredAt: new Date()
    };
    const previousIndex = stages.findIndex((item) => item?.key === key);
    if (previousIndex >= 0) stages[previousIndex] = stage;
    else stages.push(stage);
    delivery.stages = stages;
    delivery.metadata = {
        ...(delivery.metadata || {}),
        currentStage: key,
        currentStageLabel: stage.label,
        currentStageStatus: status
    };
    if (typeof delivery.markModified === 'function') {
        delivery.markModified('stages');
        delivery.markModified('metadata');
    }
    return delivery;
};

const applyReceiptDeliveryIdentity = (delivery, transaction, recipient = null) => {
    delivery.provider = 'whatchimp';
    delivery.recipientName = recipient?.name || delivery.recipientName || '';
    delivery.recipientModel = recipient?.model || delivery.recipientModel || '';
    delivery.recipientId = recipient?.id || delivery.recipientId || null;
    delivery.reference = transaction.customId || delivery.reference || '';
    return delivery;
};

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

const recordEarlyDeliveryFailure = async ({ transaction, recipient = null, recipientPhone = '', stage, result }) => {
    const trackingPhone = recipientPhone || recipient?.phone || `unresolved:${String(transaction._id)}`;
    let delivery = await WhatsAppDelivery.findOne({
        kind: 'receipt',
        transactionId: transaction._id,
        recipientPhone: trackingPhone
    });
    if (!delivery) {
        delivery = new WhatsAppDelivery({
            kind: 'receipt',
            transactionId: transaction._id,
            recipientPhone: trackingPhone
        });
    }
    applyReceiptDeliveryIdentity(delivery, transaction, recipient);
    delivery.status = 'failed';
    delivery.failureCode = result.code || 'WHATSAPP_DELIVERY_FAILED';
    delivery.failureReason = result.message || 'تعذر إرسال إيصال واتساب.';
    markDeliveryStage(delivery, 'transaction_verified', 'success');
    markDeliveryStage(delivery, stage, 'failed', delivery.failureReason);
    await saveDelivery(delivery);
    return delivery;
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
            const failure = { success: false, code: 'RECEIPT_PROOF_MISSING', message: 'لم يتم توليد صورة إيصال لهذه العملية بعد.' };
            await recordEarlyDeliveryFailure({ transaction, stage: 'receipt_ready', result: failure });
            return failure;
        }

        const configuration = getWhatChimpConfigurationStatus();
        if (!configuration.receiptReady) {
            const failure = {
                success: false,
                code: 'WHATCHIMP_RECEIPT_NOT_READY',
                message: 'إعداد قالب إيصال WhatChimp غير مكتمل.',
                missing: configuration.missing
            };
            await recordEarlyDeliveryFailure({ transaction, stage: 'configuration_verified', result: failure });
            return failure;
        }

        const recipient = await resolveReceiptRecipient(transaction);
        if (!recipient?.phone) {
            const failure = { success: false, code: 'RECEIPT_RECIPIENT_MISSING', message: 'لا يوجد رقم واتساب صالح لصاحب العملية.' };
            await recordEarlyDeliveryFailure({ transaction, recipient, stage: 'recipient_resolved', result: failure });
            return failure;
        }

        let normalizedPhone;
        try {
            normalizedPhone = normalizeWhatsAppPhone(recipient.phone);
        } catch (error) {
            const failure = { success: false, code: error.code || 'WHATSAPP_PHONE_INVALID', message: error.message };
            await recordEarlyDeliveryFailure({ transaction, recipient, stage: 'phone_normalized', result: failure });
            return failure;
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
            await recordEarlyDeliveryFailure({ transaction, recipient, recipientPhone: normalizedPhone, stage: 'receipt_link_ready', result: failure });
            await logReceiptDelivery({ success: false, transaction, recipient, result: failure });
            return failure;
        }

        const delivery = existing || new WhatsAppDelivery({
            kind: 'receipt',
            transactionId: transaction._id,
            recipientPhone: normalizedPhone
        });
        applyReceiptDeliveryIdentity(delivery, transaction, recipient);
        delivery.templateName = configuration.receiptTemplate || '';
        delivery.templateId = configuration.receiptMediaTemplateId || '';
        delivery.status = 'sending';
        delivery.failureCode = '';
        delivery.failureReason = '';
        delivery.metadata = {
            ...(delivery.metadata || {}),
            service: serviceLabel(transaction.transferType),
            receiptUrl,
            proofIndex: 0,
            recipientSource: recipient.source || 'account'
        };
        markDeliveryStage(delivery, 'transaction_verified', 'success');
        markDeliveryStage(delivery, 'receipt_ready', 'success');
        markDeliveryStage(delivery, 'configuration_verified', 'success');
        markDeliveryStage(delivery, 'recipient_resolved', 'success', recipient.source || 'account');
        markDeliveryStage(delivery, 'phone_normalized', 'success', normalizedPhone);
        markDeliveryStage(delivery, 'receipt_link_ready', 'success');
        markDeliveryStage(delivery, 'provider_request', 'active');
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
        markDeliveryStage(delivery, 'provider_request', result.success ? 'success' : 'failed', result.message || '');
        markDeliveryStage(delivery, 'provider_acceptance', result.success ? 'success' : 'failed', result.message || '');
        if (result.success) markDeliveryStage(delivery, 'provider_delivery', 'waiting', 'بانتظار تأكيد التسليم من WhatsApp.');
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

const normalizeProviderDeliveryStatus = (value) => {
    const raw = String(value || '').trim().toLowerCase();
    if (/(fail|error|reject|undeliver|block)/.test(raw)) return 'failed';
    if (/(read|seen)/.test(raw)) return 'read';
    if (/(deliver|received)/.test(raw)) return 'delivered';
    if (/(sent|accept|queued|submit)/.test(raw)) return 'sent';
    return '';
};

const updateReceiptDeliveryProviderStatus = async ({ messageId, status, reason = '', rawStatus = '' } = {}) => {
    const normalizedStatus = normalizeProviderDeliveryStatus(status);
    if (!messageId || !normalizedStatus) return { updated: false, reason: 'UNSUPPORTED_STATUS' };

    const delivery = await WhatsAppDelivery.findOne({ messageId: String(messageId) });
    if (!delivery) return { updated: false, reason: 'DELIVERY_NOT_FOUND' };

    const priority = { pending: 0, sending: 1, sent: 2, delivered: 3, read: 4, failed: 5 };
    if (normalizedStatus !== 'failed' && delivery.status !== 'failed' && (priority[normalizedStatus] || 0) >= (priority[delivery.status] || 0)) {
        delivery.status = normalizedStatus;
    }
    if (normalizedStatus === 'failed') {
        delivery.status = 'failed';
        delivery.failureCode = 'WHATCHIMP_DELIVERY_FAILED';
        delivery.failureReason = String(reason || 'تعذر تسليم الرسالة من WhatsApp.').slice(0, 1000);
    }
    delivery.metadata = {
        ...(delivery.metadata || {}),
        providerDeliveryStatus: rawStatus || status,
        providerDeliveryUpdatedAt: new Date()
    };
    markDeliveryStage(
        delivery,
        'provider_delivery',
        normalizedStatus === 'failed' ? 'failed' : 'success',
        normalizedStatus === 'failed' ? delivery.failureReason : `حالة WhatsApp: ${normalizedStatus}`
    );
    await saveDelivery(delivery);
    return { updated: true, delivery };
};

const recordWhatsAppDeliveryAttempt = async ({
    kind = 'support',
    recipientPhone = '',
    recipientName = '',
    recipientModel = '',
    recipientId = null,
    reference = '',
    result = {},
    skipped = false,
    metadata = {}
} = {}) => {
    const delivery = new WhatsAppDelivery({
        kind,
        recipientPhone: String(recipientPhone || `unresolved:${Date.now()}`).trim(),
        recipientName: String(recipientName || '').trim(),
        recipientModel: String(recipientModel || '').trim(),
        recipientId,
        reference: String(reference || '').trim(),
        provider: result.provider || 'whatchimp',
        messageId: String(result.messageId || '').trim(),
        status: skipped ? 'skipped' : (result.success ? 'sent' : 'failed'),
        failureCode: result.success ? '' : String(result.code || 'WHATCHIMP_REQUEST_FAILED'),
        failureReason: result.success ? '' : String(result.message || 'تعذر إرسال رسالة واتساب.').slice(0, 1000),
        sentAt: result.success ? new Date() : undefined,
        metadata: { ...metadata, messageKind: kind }
    });

    markDeliveryStage(
        delivery,
        'provider_request',
        skipped ? 'skipped' : (result.success ? 'success' : 'failed'),
        skipped ? delivery.failureReason : (result.message || '')
    );
    markDeliveryStage(
        delivery,
        'provider_acceptance',
        skipped ? 'skipped' : (result.success ? 'success' : 'failed'),
        skipped ? delivery.failureReason : (result.message || '')
    );
    if (result.success) markDeliveryStage(delivery, 'provider_delivery', 'waiting', 'بانتظار تأكيد التسليم من WhatsApp.');
    await saveDelivery(delivery);
    return delivery;
};

module.exports = {
    resolveReceiptRecipient,
    findCompanyTransferSender,
    findCompanyManager,
    sendCompletedTransactionReceipt,
    updateReceiptDeliveryProviderStatus,
    recordWhatsAppDeliveryAttempt,
    normalizeProviderDeliveryStatus,
    DELIVERY_STAGE_LABELS
};
