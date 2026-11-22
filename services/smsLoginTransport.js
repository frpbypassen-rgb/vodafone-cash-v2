'use strict';

const configured = () => /^rsl_[\x21-\x7e]+$/.test(process.env.RESALA_API_KEY?.trim() || '');

const sendPin = async (phone) => {
    const { sendResalaPin } = require('../src/Infrastructure/ResalaClient.ts');
    const { pin } = await sendResalaPin(phone, {
        service_name: 'Ahram Pay',
        len: 6,
        sender: process.env.RESALA_SMS_SENDER?.trim() || undefined,
    });
    if (!/^[0-9]{6}$/.test(pin)) throw new Error('SMS_PIN_INVALID');
    return pin;
};

module.exports = { configured, sendPin };
