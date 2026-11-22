'use strict';

const { generateOtp } = require('../utils/otp');
const { normalizeSmsLoginPhone } = require('../utils/smsLoginPhone');

const configured = () => /^rsl_[\x21-\x7e]+$/.test(process.env.RESALA_API_KEY?.trim() || '');

const sendPin = async (phone, { test = false } = {}) => {
    const { sendResalaPin, sendResalaTemplate } = require('../src/Infrastructure/ResalaClient.ts');
    const recipient = normalizeSmsLoginPhone(phone);
    if (!recipient) throw new Error('SMS_PHONE_INVALID');
    const sender = process.env.RESALA_SMS_SENDER?.trim() || undefined;
    const templateId = process.env.RESALA_SMS_TEMPLATE_ID?.trim();
    if (templateId) {
        const pin = generateOtp();
        const result = await sendResalaTemplate(templateId, [{ phone: recipient, $1: pin }], { sender, test });
        if (result.queued || result.is_prod !== !test || result.succeeded !== 1 || result.failed !== 0
            || result.failed_numbers.length || result.invalid_numbers.length || result.sms_template_version.status !== 'APPROVED') {
            throw new Error('SMS_TEMPLATE_NOT_ACCEPTED');
        }
        const slots = result.sms_template_version.body.match(/\$[0-9]+/g) || [];
        if (!slots.length || slots.some(slot => slot !== '$1')) throw new Error('SMS_TEMPLATE_CODE_SLOT_INVALID');
        return pin;
    }
    const { pin } = await sendResalaPin(recipient, {
        service_name: 'Ahram Pay',
        len: 6,
        sender,
        test,
    });
    if (!/^[0-9]{6}$/.test(pin)) throw new Error('SMS_PIN_INVALID');
    return pin;
};

module.exports = { configured, sendPin };
