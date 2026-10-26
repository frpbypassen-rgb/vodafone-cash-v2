'use strict';
const nodemailer = require('nodemailer');
const { getSmtpConfig, getMissingSmtpSettings } = require('./emailOtpMailer');
const configured = () => getMissingSmtpSettings(getSmtpConfig()).length === 0;
const send = async (message) => {
    if (!configured()) throw Object.assign(new Error('البريد غير مهيأ على الخادم حالياً.'), { code: 'SMTP_UNAVAILABLE', statusCode: 503 });
    const config = getSmtpConfig();
    const transport = nodemailer.createTransport({
        host: config.host, port: config.port, secure: config.secure,
        auth: { user: config.user, pass: config.pass },
        connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
    });
    try {
        const info = await transport.sendMail({ from: config.from, ...message });
        if (!info.accepted?.length) throw Object.assign(new Error('EMAIL_REJECTED'), { code: 'EENVELOPE' });
        return info;
    } finally { transport.close(); }
};
const sendCode = (email, code) => send({
    to: email, subject: 'تأكيد بريد كشف الحساب — أهرام باي',
    text: `رمز تأكيد بريد كشف الحساب: ${code}\nصالح لمدة 10 دقائق. لا تشارك الرمز مع أحد.\nهذا الرمز خاص بالاشتراك في الكشوف اليومية، ولا يغير بيانات تسجيل الدخول.`,
});
const sendStatement = ({ email, day, pdf, test = false }) => send({
    to: email, subject: `${test ? 'كشف تجريبي' : 'كشف الحساب اليومي'} — ${day} — أهرام باي`,
    text: `مرفق كشف حساب الوكيل من التقارير الشاملة للإدارة ليوم ${day} حسب توقيت ليبيا.\nالكشف يستخدم نفس مصدر البيانات والحسابات وقالب PDF الخاص بتقارير الإدارة.\nيمكنك إيقاف الكشوف أو تغيير البريد من الإعدادات ← الإشعارات.`,
    attachments: [{ filename: `Ahram-statement-${day}.pdf`, content: pdf, contentType: 'application/pdf' }],
});
module.exports = { configured, sendCode, sendStatement };
