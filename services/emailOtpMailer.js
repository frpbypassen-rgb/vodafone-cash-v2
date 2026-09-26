'use strict';

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
const { getBrandContact, isLoginOtpEmailTemplateV2Enabled } = require('../utils/brandContact');
const { normalizeSubmittedOtp } = require('../utils/otp');
const { isValidOtpEmail, normalizeOtpEmail } = require('../utils/otpDeliveryChannel');
const legacyTemplate = require('./emailOtpTemplateLegacy');

const DEFAULT_FROM = legacyTemplate.DEFAULT_FROM;
const LOGIN_OTP_LOGO_URL = 'https://ahrampay.com/images/login-otp-logo.jpg';
const LOGIN_OTP_LOGO_PATH = path.join(__dirname, '../public/images/login-otp-logo.jpg');
const LOGIN_OTP_TEMPLATE_PATH = path.join(__dirname, '../views/emails/login-otp.ejs');
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKET', 'ECONNECTION', 'ECONNRESET', 'ECONNREFUSED']);
const TRIPOLI_TIME_ZONE = 'Africa/Tripoli';

let transportCache = { key: '', transport: null };
let templateCache = '';

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
    const fromOverride = String(env.SMTP_FROM || '').trim();
    const from = fromOverride || (
        isLoginOtpEmailTemplateV2Enabled(env) ? getBrandContact(env).from : DEFAULT_FROM
    );
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

const COPY = Object.freeze({
    body: 'تلقينا محاولة تسجيل دخول إلى حسابك. استخدم رمز التحقق التالي لإكمال العملية بأمان.',
    phoneLabel: 'هاتف',
    warning: 'لا تشارك الرمز مع أي شخص، حتى لو ادعى أنه من فريق الدعم.'
});

const OTP_COUNT_PHRASES = Object.freeze({
    1: 'الرقم',
    2: 'الرقمين',
    3: 'الأرقام الثلاثة',
    4: 'الأرقام الأربعة',
    5: 'الأرقام الخمسة',
    6: 'الأرقام الستة',
    7: 'الأرقام السبعة',
    8: 'الأرقام الثمانية',
    9: 'الأرقام التسعة',
    10: 'الأرقام العشرة'
});

const cleanInline = (value) => String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim();

const formatArabicMinutes = (value) => {
    const minutes = Math.round(Number(value));
    if (!Number.isFinite(minutes)) return '';
    const count = Math.abs(minutes);
    if (count === 1) return 'دقيقة واحدة';
    if (count === 2) return 'دقيقتين';
    if (count >= 3 && count <= 10) return `${count} دقائق`;
    return `${count} دقيقة`;
};

const resolveExpiresMinutes = (value) => {
    const minutes = Number(value);
    if (!Number.isInteger(minutes) || minutes <= 0) return 5;
    return minutes;
};

const describeOtpDigits = (otp) => {
    const length = String(otp || '').length;
    if (OTP_COUNT_PHRASES[length]) return OTP_COUNT_PHRASES[length];
    if (length >= 11) return `${length} رقماً`;
    return 'الأرقام';
};

const formatLoginAttemptTime = (value) => {
    if (value == null || value === '') return '';
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('ar-LY', {
        timeZone: TRIPOLI_TIME_ZONE,
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).format(date);
};

const detectBrowser = (ua) => {
    if (/EdgA?\//.test(ua) || /Edge\//.test(ua)) return 'Edge';
    if (/OPR\/|Opera\//.test(ua)) return 'Opera';
    if (/SamsungBrowser\//.test(ua)) return 'Samsung Internet';
    if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox';
    if (/CriOS\//.test(ua) || /Chrome\//.test(ua)) return 'Chrome';
    if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'Safari';
    return '';
};

const detectOs = (ua) => {
    if (/Windows/.test(ua)) return 'Windows';
    if (/iPhone|iPad|iPod/.test(ua)) return 'iOS';
    if (/Android/.test(ua)) return 'Android';
    if (/Mac OS X|Macintosh/.test(ua)) return 'macOS';
    if (/CrOS/.test(ua)) return 'ChromeOS';
    if (/Linux/.test(ua)) return 'Linux';
    return '';
};

const summarizeLoginUserAgent = (value) => {
    const ua = cleanInline(value);
    if (!ua) return '';
    const browser = detectBrowser(ua);
    const os = detectOs(ua);
    if (browser && os) return `${browser} على ${os}`;
    if (browser) return browser;
    if (os) return os;
    return '';
};

const maskLoginAccount = (value) => {
    const cleaned = cleanInline(value);
    if (!cleaned) return '';
    if (cleaned.includes('@')) {
        const at = cleaned.indexOf('@');
        const local = cleaned.slice(0, at);
        const domain = cleaned.slice(at + 1).toLowerCase();
        if (!local || !domain || /[\s@]/.test(domain)) return '';
        const keep = local.length >= 3 ? 3 : 1;
        return `${local.slice(0, keep).toLowerCase()}***@${domain}`;
    }
    const compact = cleaned.replace(/[\s().-]/g, '');
    const phoneBody = compact.replace(/^\+/, '');
    if (/^\d{8,15}$/.test(phoneBody)) {
        return `${phoneBody.slice(0, 3)}${'*'.repeat(phoneBody.length - 6)}${phoneBody.slice(-3)}`;
    }
    if (cleaned.length < 2) return '';
    const keep = cleaned.length >= 4 ? 3 : 1;
    return `${cleaned.slice(0, keep)}***`;
};

const resolveLoginOtpLogo = (brand) => {
    try {
        if (fs.existsSync(LOGIN_OTP_LOGO_PATH)) {
            return { src: brand.logoUrl, alt: brand.name };
        }
    } catch {
        return null;
    }
    return null;
};

const LRM = '\u200E';
const LRI = '\u2066';
const PDI = '\u2069';

const embedPlainLtr = (value) => `${LRM}${LRI}${value}${PDI}`;

const buildAttemptRows = ({ attemptAt, userAgent, loginAccount } = {}) => {
    const rows = [];
    const time = formatLoginAttemptTime(attemptAt);
    const device = summarizeLoginUserAgent(userAgent);
    const account = maskLoginAccount(loginAccount);
    if (time) rows.push({ label: 'وقت المحاولة', value: time, ltr: true });
    if (device) rows.push({ label: 'الجهاز', value: device, ltr: true });
    if (account) rows.push({ label: 'الحساب', value: account, ltr: true });
    return rows;
};

const buildLoginOtpView = (input = {}) => {
    const brand = getBrandContact();
    const accountName = cleanInline(input.accountName);
    const otp = normalizeSubmittedOtp(input.otp);
    const expiresMinutes = resolveExpiresMinutes(input.expiresMinutes);
    const expiresPhrase = formatArabicMinutes(expiresMinutes);
    const logo = Object.prototype.hasOwnProperty.call(input, 'logo') ? input.logo : resolveLoginOtpLogo(brand);
    const year = input.year == null || input.year === '' ? new Date().getFullYear() : input.year;
    return {
        brand: brand.name,
        accountName,
        greeting: accountName ? `مرحبًا ${accountName}،` : 'مرحبًا بك،',
        body: COPY.body,
        otp,
        expiresMinutes,
        expiresPhrase,
        otpDigitsPhrase: describeOtpDigits(otp),
        attemptRows: buildAttemptRows(input),
        contactEmail: brand.supportEmail,
        contactPhone: brand.phoneDisplay,
        contactPhoneLink: brand.phoneHref,
        websiteUrl: brand.website,
        websiteHost: brand.websiteHost,
        websiteLabel: brand.website,
        contactAddress: brand.address,
        warning: COPY.warning,
        phoneLabel: COPY.phoneLabel,
        year,
        logoSrc: logo && logo.src ? logo.src : '',
        logoAlt: logo && logo.alt ? logo.alt : brand.name
    };
};

const renderLoginOtpTemplate = (view) => {
    if (!templateCache) templateCache = fs.readFileSync(LOGIN_OTP_TEMPLATE_PATH, 'utf8');
    return ejs.render(templateCache, view, { filename: LOGIN_OTP_TEMPLATE_PATH });
};

const buildLoginOtpHtmlV2 = (input = {}) => renderLoginOtpTemplate(buildLoginOtpView(input));

const buildLoginOtpTextV2 = (input = {}) => {
    const view = buildLoginOtpView(input);
    const lines = [
        view.brand,
        '',
        view.greeting,
        '',
        view.body,
        '',
        'رمز التحقق',
        embedPlainLtr(view.otp),
        '',
        `ينتهي خلال ${view.expiresPhrase}`,
        ''
    ];
    if (view.attemptRows.length) {
        lines.push('تفاصيل المحاولة');
        view.attemptRows.forEach((row) => {
            const value = row.ltr ? embedPlainLtr(row.value) : row.value;
            lines.push(`${row.label}: ${value}`);
        });
        lines.push('');
    }
    lines.push(
        'طريقة استخدام الرمز',
        `1. ارجع إلى شاشة تسجيل الدخول المفتوحة في موقع أو تطبيق ${view.brand}.`,
        `2. أدخل ${view.otpDigitsPhrase} في خانة «رمز التحقق» بنفس الترتيب الظاهر أعلاه.`,
        '3. اضغط «تأكيد الدخول». لا يمكن استخدام الرمز مرة أخرى بعد نجاح التحقق.',
        '',
        'نصائح لحماية حسابك',
        view.warning,
        'لن نطلب منك الرمز عبر الهاتف أو الرسائل أو روابط خارجية.',
        `تأكد أن عنوان الموقع يبدأ بـ ${embedPlainLtr(view.websiteHost)} قبل إدخال الرمز.`,
        'إذا لم تبدأ محاولة الدخول، غيّر كلمة المرور وتواصل معنا فورًا.',
        '',
        view.contactAddress,
        `${view.phoneLabel} ${embedPlainLtr(view.contactPhone)}`,
        embedPlainLtr(view.contactEmail),
        embedPlainLtr(view.websiteUrl),
        '',
        `${embedPlainLtr(`© ${view.year}`)} ${view.brand}. جميع الحقوق محفوظة.`
    );
    return lines.join('\n');
};

const useLoginOtpTemplateV2 = () => isLoginOtpEmailTemplateV2Enabled();

const buildLoginOtpHtml = (input = {}) => (
    useLoginOtpTemplateV2() ? buildLoginOtpHtmlV2(input) : legacyTemplate.buildLoginOtpHtml(input)
);

const buildLoginOtpText = (input = {}) => (
    useLoginOtpTemplateV2() ? buildLoginOtpTextV2(input) : legacyTemplate.buildLoginOtpText(input)
);

const failure = (code) => ({
    success: false,
    provider: 'smtp',
    channel: 'email',
    code
});

const sendLoginOtpEmail = async ({
    to,
    otp,
    expiresMinutes = 5,
    expiresAt,
    accountName = '',
    attemptAt,
    userAgent,
    loginAccount,
    year
} = {}) => {
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

    const content = {
        otp,
        expiresMinutes,
        expiresAt,
        accountName,
        attemptAt,
        userAgent,
        loginAccount,
        year
    };

    try {
        const transport = getTransport(config);
        const info = await transport.sendMail({
            from: config.from,
            to: email,
            subject: useLoginOtpTemplateV2()
                ? `رمز التحقق لتسجيل الدخول — ${getBrandContact().name}`
                : LOGIN_OTP_SUBJECT,
            text: buildLoginOtpText(content),
            html: buildLoginOtpHtml(content)
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
    LOGIN_OTP_LOGO_URL,
    LOGIN_OTP_SUBJECT,
    buildLoginOtpHtml,
    buildLoginOtpHtmlV2,
    buildLoginOtpText,
    buildLoginOtpTextV2,
    formatArabicMinutes,
    formatLoginAttemptTime,
    getMissingSmtpSettings,
    getSmtpConfig,
    maskLoginAccount,
    resetEmailTransport,
    sendLoginOtpEmail,
    summarizeLoginUserAgent
};
