'use strict';

const DEFAULT_BRAND = Object.freeze({
    name: 'أهرام باي',
    supportEmail: 'support@ahrampay.com',
    phoneTel: '0913731533',
    phoneDisplay: '0913731533',
    address: 'ليبيا / مصراتة، سوق الاستثمار / أمام المسجد العالي',
    website: 'https://ahrampay.com'
});

const FROM_MAILBOX = 'noreply@ahrampay.com';
const LOGO_PATH = '/images/login-otp-logo.jpg';

const clean = (value, fallback) => {
    const text = String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim();
    return text || fallback;
};

const compactPhone = (phone) => {
    const compact = String(phone || '').replace(/[^\d+]/g, '');
    if (!compact) return DEFAULT_BRAND.phoneTel;
    if (compact.startsWith('+')) return `+${compact.slice(1).replace(/\D/g, '')}`;
    return compact.replace(/\D/g, '');
};

const websiteOrigin = (website) => {
    try {
        return new URL(website).origin;
    } catch {
        return 'https://ahrampay.com';
    }
};

const websiteHost = (website) => {
    try {
        return new URL(website).host;
    } catch {
        return 'ahrampay.com';
    }
};

const getBrandContact = (env = process.env) => {
    const name = clean(env.BRAND_NAME, DEFAULT_BRAND.name);
    const supportEmail = clean(env.BRAND_SUPPORT_EMAIL, DEFAULT_BRAND.supportEmail);
    const phoneTel = compactPhone(clean(env.BRAND_PHONE_TEL, DEFAULT_BRAND.phoneTel));
    const phoneDisplay = clean(env.BRAND_PHONE_DISPLAY, DEFAULT_BRAND.phoneDisplay);
    const address = clean(env.BRAND_ADDRESS, DEFAULT_BRAND.address);
    const website = clean(env.BRAND_WEBSITE, DEFAULT_BRAND.website);
    const origin = websiteOrigin(website);
    return {
        name,
        supportEmail,
        phoneTel,
        phoneDisplay,
        phoneHref: `tel:${phoneTel}`,
        address,
        website,
        websiteHost: websiteHost(website),
        logoUrl: `${origin}${LOGO_PATH}`,
        from: `${name} <${FROM_MAILBOX}>`
    };
};

const isLoginOtpEmailTemplateV2Enabled = (env = process.env) => (
    ['1', 'true', 'yes', 'on'].includes(String(env.LOGIN_OTP_EMAIL_TEMPLATE_V2 || '').trim().toLowerCase())
);

module.exports = {
    DEFAULT_BRAND,
    getBrandContact,
    isLoginOtpEmailTemplateV2Enabled
};
