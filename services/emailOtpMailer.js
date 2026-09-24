'use strict';

const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
const { isValidOtpEmail, normalizeOtpEmail } = require('../utils/otpDeliveryChannel');

const DEFAULT_FROM = 'Ahram Pay <noreply@ahrampay.com>';
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'ECONNRESET', 'ECONNREFUSED']);

let transportCache = { key: '', transport: null };

const isEnabledFlag = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());

const getSmtpConfig = (env = process.env) => {
    const host = String(env.SMTP_HOST || '').trim();
    const parsedPort = Number(env.SMTP_PORT);
    const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
        ? parsedPort
        : 587;
    const rawSecure = String(env.SMTP_SECURE ?? '').trim().toLowerCase();
    const secure = rawSecure === '' ? port === 465 : isEnabledFlag(rawSecure);
    const user = String(env.SMTP_USER || '').trim();
    const pass = env.SMTP_PASS == null ? '' : String(env.SMTP_PASS);
    const from = String(env.SMTP_FROM || '').trim() || DEFAULT_FROM;
    return { host, port, secure, user, pass, from };
};

const getMissingSmtpSettings = (config) => {
    const missing = [];
    if (!config.host) missing.push('SMTP_HOST');
    if (!config.user) missing.push('SMTP_USER');
    if (!config.pass) missing.push('SMTP_PASS');
    return missing;
};

const resetEmailTransport = () => {
    transportCache = { key: '', transport: null };
};

const getTransport = (config) => {
    const key = [config.host, config.port, config.secure ? '1' : '0', config.user, config.pass].join('\n');
    if (transportCache.transport && transportCache.key === key) return transportCache.transport;
    const transport = nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: {
            user: config.user,
            pass: config.pass
        },
        connectionTimeout: 15000,
        greetingTimeout: 15000,
        socketTimeout: 20000
    });
    transportCache = { key, transport };
    return transport;
};

const LOGIN_OTP_SUBJECT = 'رمز التحقق لتسجيل الدخول — أهرام باي';
const TRIPOLI_TIME_ZONE = 'Africa/Tripoli';

const COPY = Object.freeze({
    brand: 'الأهرام للاتصالات والتقنية',
    label: 'تأكيد البريد الإلكتروني',
    heading: 'رمز تفعيل حسابك في أهرام باي',
    body: 'استخدم رمز التحقق التالي لإكمال تسجيل الدخول وتفعيل بريدك الإلكتروني.',
    otpLabel: 'رمز التفعيل',
    security: 'إذا لم تحاول تسجيل الدخول، تجاهل هذه الرسالة ولا تشارك الرمز مع أي شخص.',
    contactIntro: 'لا تتردد بالاتصال بنا إذا كان لديك أي أسئلة أو استفسارات.',
    city: 'المدينة : ليبيا / مصراتة',
    location: 'الموقع : مصراتة / سوق الاستثمار / أمام المسجد العالي',
    phoneLabel: 'رقم الهاتف :',
    phone: '+218 940719000',
    phoneHref: 'tel:+218940719000',
    emailLabel: 'البريد الإلكتروني :',
    email: 'support@ahrampay.com',
    siteLabel: 'موقعنا الإلكتروني :',
    site: 'https://ahrampay.com',
    signOff: 'مع أطيب التحيات ، فريق شركة الاهرام',
    footer: '© 2027 شركة الاهرام للاتصالات والتقنية. جميع الحقوق محفوظة.'
});

const escapeHtml = (value) => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const cleanInline = (value) => String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();

const formatLoginOtpExpiresAt = (value) => {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: TRIPOLI_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date);
    const pick = (type) => {
        const part = parts.find((item) => item.type === type);
        return part ? part.value : '';
    };
    const hour = pick('hour') === '24' ? '00' : pick('hour');
    return `${pick('day')}-${pick('month')}-${pick('year')} ${hour}:${pick('minute')}`;
};

const resolveExpiresDate = ({ expiresAt, expiresMinutes, now = new Date() } = {}) => {
    if (expiresAt) {
        const date = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
        if (!Number.isNaN(date.getTime())) return date;
    }
    const minutes = Math.max(1, Number(expiresMinutes) || 5);
    const base = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    return new Date(base.getTime() + (minutes * 60 * 1000));
};

const buildLoginOtpContent = ({ otp, expiresMinutes, expiresAt, accountName, now } = {}) => {
    const name = cleanInline(accountName);
    const code = String(otp == null ? '' : otp).replace(/[\r\n]+/g, '');
    const expiresText = formatLoginOtpExpiresAt(resolveExpiresDate({ expiresAt, expiresMinutes, now }));
    return {
        ...COPY,
        greeting: name ? `مرحباً ${name}،` : 'مرحباً،',
        otp: code,
        expiresText,
        expiryLine: `تنتهي صلاحية هذا الرمز في ${expiresText}`
    };
};

const buildLoginOtpText = (input = {}) => {
    const content = buildLoginOtpContent(input);
    return [
        content.brand,
        '',
        content.label,
        content.heading,
        '',
        content.greeting,
        '',
        content.body,
        '',
        content.otpLabel,
        content.otp,
        '',
        content.expiryLine,
        '',
        content.security,
        '',
        content.contactIntro,
        content.city,
        content.location,
        `${content.phoneLabel} ${content.phone}`,
        `${content.emailLabel} ${content.email}`,
        `${content.siteLabel} ${content.site}`,
        '',
        content.signOff,
        '',
        content.footer
    ].join('\n');
};

const buildLoginOtpHtml = (input = {}) => {
    const content = buildLoginOtpContent(input);
    const greeting = escapeHtml(content.greeting);
    const otp = escapeHtml(content.otp);
    const expiresText = escapeHtml(content.expiresText);
    const font = "Tahoma,Arial,sans-serif";
    return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(LOGIN_OTP_SUBJECT)}</title>
</head>
<body style="margin:0;padding:0;background:#e8edf1;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:#e8edf1;">رمز التحقق لتسجيل الدخول إلى أهرام باي</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="rtl" style="background:#e8edf1;border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0;">
<tr>
<td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" dir="rtl" style="width:600px;max-width:600px;background:#ffffff;border-collapse:collapse;mso-table-lspace:0;mso-table-rspace:0;">
<tr>
<td align="center" bgcolor="#111111" style="background:#111111;padding:28px 24px 24px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" dir="rtl">
<tr>
<td align="center" bgcolor="#ffffff" width="44" height="44" style="width:44px;height:44px;background:#ffffff;color:#111111;font-family:${font};font-size:22px;font-weight:700;line-height:44px;text-align:center;">أ</td>
</tr>
<tr>
<td align="center" style="padding-top:12px;color:#ffffff;font-family:${font};font-size:20px;font-weight:700;line-height:1.5;">${escapeHtml(content.brand)}</td>
</tr>
</table>
</td>
</tr>
<tr>
<td dir="rtl" align="right" style="padding:28px 36px 0;text-align:right;font-family:${font};">
<div style="color:#7a8ea3;font-size:13px;line-height:1.6;">${escapeHtml(content.label)}</div>
<div style="margin-top:10px;color:#1a1a1a;font-size:26px;font-weight:700;line-height:1.45;">${escapeHtml(content.heading)}</div>
<div style="margin-top:18px;color:#222222;font-size:16px;font-weight:700;line-height:1.6;">${greeting}</div>
<div style="margin-top:8px;color:#66727c;font-size:14px;line-height:1.8;">${escapeHtml(content.body)}</div>
</td>
</tr>
<tr>
<td style="padding:20px 36px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f6f8" style="background:#f3f6f8;border-radius:12px;border-collapse:collapse;">
<tr>
<td align="center" style="padding:22px 16px 8px;color:#2f6fdb;font-family:${font};font-size:16px;font-weight:700;line-height:1.5;">${escapeHtml(content.otpLabel)}</td>
</tr>
<tr>
<td align="center" style="padding:8px 16px 24px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="border:2px dashed #e0b44a;border-radius:12px;border-collapse:separate;">
<tr>
<td dir="ltr" align="center" style="padding:14px 36px;color:#111111;font-family:${font};font-size:36px;font-weight:700;letter-spacing:6px;line-height:1.2;text-align:center;">${otp}</td>
</tr>
</table>
</td>
</tr>
</table>
</td>
</tr>
<tr>
<td style="padding:14px 36px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#fff4d4" style="background:#fff4d4;border-radius:10px;border-collapse:collapse;">
<tr>
<td align="center" style="padding:12px 16px;color:#3a3a3a;font-family:${font};font-size:14px;line-height:1.6;text-align:center;">${escapeHtml(content.expiryLine)}</td>
</tr>
</table>
</td>
</tr>
<tr>
<td style="padding:14px 36px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="rtl" bgcolor="#f5f7f9" style="background:#f5f7f9;border-radius:10px;border-collapse:collapse;">
<tr>
<td dir="ltr" width="36" valign="middle" align="center" style="width:36px;padding:8px 4px 8px 10px;color:#222222;font-family:Georgia,serif;font-size:42px;line-height:42px;text-align:center;">)</td>
<td dir="rtl" align="right" valign="middle" style="padding:16px 8px 16px 16px;color:#4a5560;font-family:${font};font-size:14px;line-height:1.8;text-align:right;">${escapeHtml(content.security)}</td>
</tr>
</table>
</td>
</tr>
<tr>
<td style="padding:14px 36px 0;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" dir="rtl" bgcolor="#f7f8fa" style="background:#f7f8fa;border-radius:10px;border-collapse:collapse;">
<tr>
<td dir="rtl" align="right" style="padding:18px 18px 16px;text-align:right;font-family:${font};color:#4a5560;font-size:14px;line-height:1.9;">
<div style="margin-bottom:8px;">${escapeHtml(content.contactIntro)}</div>
<div>${escapeHtml(content.city)}</div>
<div>${escapeHtml(content.location)}</div>
<div>${escapeHtml(content.phoneLabel)} <a href="${content.phoneHref}" dir="ltr" style="color:#1a73e8;text-decoration:none;">${escapeHtml(content.phone)}</a></div>
<div>${escapeHtml(content.emailLabel)} <a href="mailto:${content.email}" dir="ltr" style="color:#1a73e8;text-decoration:none;">${escapeHtml(content.email)}</a></div>
<div>${escapeHtml(content.siteLabel)} <a href="${content.site}" dir="ltr" style="color:#1a73e8;text-decoration:none;">${escapeHtml(content.site)}</a></div>
</td>
</tr>
</table>
</td>
</tr>
<tr>
<td align="center" style="padding:22px 36px 8px;color:#333333;font-family:${font};font-size:15px;line-height:1.7;text-align:center;">${escapeHtml(content.signOff)}</td>
</tr>
<tr>
<td align="center" bgcolor="#f7f8fa" style="background:#f7f8fa;padding:16px 24px 20px;color:#8b949e;font-family:${font};font-size:12px;line-height:1.6;text-align:center;">${escapeHtml(content.footer)}</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;
};

const failure = (code) => ({
    success: false,
    provider: 'smtp',
    channel: 'email',
    code
});

const sendLoginOtpEmail = async ({ to, otp, expiresMinutes = 5, expiresAt, accountName = '' } = {}) => {
    const email = normalizeOtpEmail(to);
    if (!isValidOtpEmail(email)) return failure('EMAIL_OTP_ADDRESS_INVALID');

    const config = getSmtpConfig();
    const missing = getMissingSmtpSettings(config);
    if (missing.length) {
        logger.security('login email otp config missing', {
            code: 'SMTP_CONFIG_MISSING',
            missing
        });
        return failure('SMTP_CONFIG_MISSING');
    }

    try {
        const transport = getTransport(config);
        const info = await transport.sendMail({
            from: config.from,
            to: email,
            subject: LOGIN_OTP_SUBJECT,
            text: buildLoginOtpText({ otp, expiresMinutes, expiresAt, accountName }),
            html: buildLoginOtpHtml({ otp, expiresMinutes, expiresAt, accountName })
        });
        return {
            success: true,
            provider: 'smtp',
            channel: 'email',
            messageId: info && info.messageId ? String(info.messageId) : ''
        };
    } catch (error) {
        const smtpCode = error && error.code ? String(error.code).slice(0, 40) : '';
        const code = TIMEOUT_CODES.has(smtpCode) ? 'EMAIL_OTP_TIMEOUT' : 'EMAIL_OTP_SEND_FAILED';
        logger.security('login email otp failed', { code, smtpCode });
        return failure(code);
    }
};

module.exports = {
    DEFAULT_FROM,
    LOGIN_OTP_SUBJECT,
    buildLoginOtpHtml,
    buildLoginOtpText,
    formatLoginOtpExpiresAt,
    getMissingSmtpSettings,
    getSmtpConfig,
    resetEmailTransport,
    sendLoginOtpEmail
};
