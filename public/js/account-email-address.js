/*
 * Shared account-email rules for the browser and the server.
 * Trim, lowercase, at most 254 characters, exactly one @, a non-empty
 * local part, and a domain with at least one dot whose TLD is 2+ letters.
 * No domain allowlist, blocklist, or MX lookup.
 */
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    root.AhramEmailAddress = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const EMAIL_REQUIRED_MESSAGE = 'البريد الإلكتروني مطلوب.';
    const EMAIL_INVALID_MESSAGE = 'أدخل بريداً إلكترونياً صالحاً.';
    const EMAIL_TAKEN_MESSAGE = 'هذا البريد الإلكتروني مستخدم في حساب آخر.';
    const LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/;

    const normalizeEmailAddress = (value) => String(value == null ? '' : value).trim().toLowerCase();

    const isSaneEmailAddress = (email) => {
        if (!email || email.length > 254) return false;
        const at = email.indexOf('@');
        if (at <= 0 || email.lastIndexOf('@') !== at) return false;
        const local = email.slice(0, at);
        const domain = email.slice(at + 1);
        if (!local || /[\s@]/.test(local) || local.includes('..') || local.startsWith('.') || local.endsWith('.')) {
            return false;
        }
        if (!domain || domain.includes('..') || domain.startsWith('.') || domain.endsWith('.')) return false;
        const labels = domain.split('.');
        if (labels.length < 2 || !labels.every((label) => LABEL_PATTERN.test(label))) return false;
        return /^[a-z]{2,}$/.test(labels[labels.length - 1]);
    };

    const classifyEmailAddress = (value) => {
        const email = normalizeEmailAddress(value);
        if (!email) {
            return { ok: false, email: '', code: 'required', message: EMAIL_REQUIRED_MESSAGE };
        }
        if (!isSaneEmailAddress(email)) {
            return { ok: false, email: '', code: 'invalid', message: EMAIL_INVALID_MESSAGE };
        }
        return { ok: true, email, code: '', message: '' };
    };

    const isValidEmailAddress = (value) => classifyEmailAddress(value).ok;

    return {
        EMAIL_INVALID_MESSAGE,
        EMAIL_REQUIRED_MESSAGE,
        EMAIL_TAKEN_MESSAGE,
        classifyEmailAddress,
        isValidEmailAddress,
        normalizeEmailAddress
    };
}));
