'use strict';

const { normalizeWhatsAppPhone, sendWhatChimpText } = require('./whatsappService');

const clean = (value) => String(value || '').trim();

/**
 * Sends a non-sensitive confirmation to the new number after an administrator
 * changes a contact number. Failure never rolls back the database update: the
 * new contact number is still the authoritative destination for future notices.
 */
const notifyAccountPhoneChanged = async ({ oldPhone, newPhone, accountName, accountLabel }) => {
    const before = clean(oldPhone);
    const after = clean(newPhone);
    if (!after || before === after) return { attempted: false, reason: 'unchanged' };

    try {
        const recipientPhone = normalizeWhatsAppPhone(after);
        const result = await sendWhatChimpText({
            phone: recipientPhone,
            message: `تم تحديث رقم التواصل لحساب ${clean(accountName) || accountLabel || 'Ahram Pay'} بنجاح. أصبح هذا الرقم هو رقم الإشعارات المعتمد. إذا لم تطلب هذا التعديل، تواصل مع الدعم فوراً.`
        });
        return {
            attempted: true,
            delivered: Boolean(result?.success),
            recipientPhone,
            providerCode: result?.code || null
        };
    } catch (error) {
        return {
            attempted: true,
            delivered: false,
            providerCode: error?.code || 'WHATSAPP_NOTIFICATION_FAILED'
        };
    }
};

module.exports = { notifyAccountPhoneChanged };
