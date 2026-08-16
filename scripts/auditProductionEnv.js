'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const envPath = path.resolve(process.argv[2] || '.env');
const examplePath = path.resolve(process.argv[3] || '.env.example');

if (!fs.existsSync(envPath)) {
    console.error(`[ERROR] Environment file was not found: ${envPath}`);
    process.exit(2);
}

const source = fs.readFileSync(envPath, 'utf8');
const env = dotenv.parse(source);
const errors = [];
const warnings = [];
const notes = [];
const keyCounts = new Map();

for (const line of source.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) continue;
    keyCounts.set(match[1], (keyCounts.get(match[1]) || 0) + 1);
}

const clean = (key) => String(env[key] || '').trim();
const enabled = (key) => ['1', 'true', 'yes', 'on'].includes(clean(key).toLowerCase());
const disabled = (key) => ['0', 'false', 'no', 'off'].includes(clean(key).toLowerCase());
const placeholder = (value) => /your_|change[_-]?me|generate_|placeholder|example\.com|not[_-]?for[_-]?production/i.test(value);
const addError = (key, message) => errors.push({ key, message });
const addWarning = (key, message) => warnings.push({ key, message });

const requireValue = (key, options = {}) => {
    const value = clean(key);
    if (!value) {
        addError(key, 'missing or empty');
        return '';
    }
    if (options.noPlaceholder !== false && placeholder(value)) {
        addError(key, 'contains a placeholder value');
    }
    if (options.minLength && value.length < options.minLength) {
        addError(key, `must contain at least ${options.minLength} characters`);
    }
    return value;
};

const requireHttpsUrl = (key) => {
    const value = requireValue(key);
    if (!value) return null;
    try {
        const url = new URL(value);
        if (url.protocol !== 'https:') addError(key, 'must use HTTPS in production');
        return url;
    } catch (_error) {
        addError(key, 'is not a valid URL');
        return null;
    }
};

if (clean('NODE_ENV') !== 'production') addError('NODE_ENV', 'must equal production');

const port = Number(clean('PORT'));
if (!Number.isInteger(port) || port < 1 || port > 65535) addError('PORT', 'must be an integer from 1 to 65535');

const mongoUri = requireValue('MONGO_URI');
if (mongoUri && (!/^mongodb(?:\+srv)?:\/\//i.test(mongoUri) || /^demo$/i.test(mongoUri))) {
    addError('MONGO_URI', 'must be a real MongoDB connection URI');
}

for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'SESSION_SECRET', 'OTP_SECRET']) {
    requireValue(key, { minLength: 32 });
}

requireValue('PANEL_USER');
requireValue('PANEL_PASS', { minLength: 10 });
requireValue('RECEIPT_SHARE_SECRET', { minLength: 32 });
requireValue('WEB_PUSH_PUBLIC_KEY', { minLength: 80 });
requireValue('WEB_PUSH_PRIVATE_KEY', { minLength: 40 });

const publicUrl = requireHttpsUrl('PUBLIC_APP_URL');
const pushSubject = requireValue('WEB_PUSH_SUBJECT');
if (pushSubject && !/^(mailto:|https:\/\/)/i.test(pushSubject)) {
    addError('WEB_PUSH_SUBJECT', 'must start with mailto: or https://');
}

const allowedOrigins = clean('ALLOWED_ORIGINS')
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean);
if (!allowedOrigins.length) {
    addWarning('ALLOWED_ORIGINS', 'is empty; explicit production origins are recommended');
} else if (publicUrl && !allowedOrigins.includes(publicUrl.origin)) {
    addWarning('ALLOWED_ORIGINS', 'does not include the PUBLIC_APP_URL origin');
}

if (!enabled('SECURE_COOKIE')) addWarning('SECURE_COOKIE', 'should be true behind production HTTPS');
const sameSite = clean('COOKIE_SAMESITE').toLowerCase();
if (sameSite && !['lax', 'strict', 'none'].includes(sameSite)) {
    addError('COOKIE_SAMESITE', 'must be lax, strict, or none');
}
if (sameSite === 'none' && !enabled('SECURE_COOKIE')) {
    addError('SECURE_COOKIE', 'must be true when COOKIE_SAMESITE is none');
}

if (enabled('BYPASS_OTP') || enabled('BYPASS_CLIENT_OTP')) {
    addWarning('OTP_BYPASS', 'an OTP bypass is enabled in production');
}
if (clean('MASTER_OTP')) addWarning('MASTER_OTP', 'a fixed master OTP is configured');

if (enabled('REDIS_REQUIRED') && disabled('REDIS_ENABLED')) {
    addError('REDIS_ENABLED', 'cannot be false while REDIS_REQUIRED is true');
}
if ((enabled('REDIS_ENABLED') || enabled('REDIS_REQUIRED')) && !clean('REDIS_URL') && !clean('REDIS_URI')) {
    addError('REDIS_URL', 'REDIS_URL or REDIS_URI is required when Redis is enabled');
}
if (disabled('REDIS_ENABLED')) notes.push('Redis is explicitly disabled; the single PM2 process uses in-memory locks/cache.');

if (enabled('WHATCHIMP_ENABLED')) {
    requireHttpsUrl('WHATCHIMP_API_BASE_URL');
    requireValue('WHATCHIMP_API_TOKEN');
    requireValue('WHATCHIMP_PHONE_NUMBER_ID');
    requireValue('WHATCHIMP_WEBHOOK_SECRET', { minLength: 32 });
    requireValue('WHATCHIMP_OTP_TEMPLATE');
    requireValue('WHATCHIMP_RATE_CHANGE_TEMPLATE');
    requireValue('WHATCHIMP_RATE_CHANGE_VARIABLE_ORDER');
    if (!clean('WHATCHIMP_RECEIPT_MEDIA_TEMPLATE_ID') && !clean('WHATCHIMP_RECEIPT_TEMPLATE')) {
        addError('WHATCHIMP_RECEIPT_TEMPLATE', 'a receipt media template ID or receipt template is required');
    }
    const timeout = Number(clean('WHATCHIMP_REQUEST_TIMEOUT_MS') || 15000);
    if (!Number.isFinite(timeout) || timeout < 3000) {
        addError('WHATCHIMP_REQUEST_TIMEOUT_MS', 'must be at least 3000 milliseconds');
    }
} else {
    addWarning('WHATCHIMP_ENABLED', 'WhatsApp delivery is disabled');
}

if (clean('ADMIN_BOT_TOKEN') && !clean('ADMIN_TELEGRAM_ID')) {
    addWarning('ADMIN_TELEGRAM_ID', 'is missing while the administration Telegram bot token is configured');
}

const duplicateKeys = [...keyCounts.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => key)
    .sort();
if (duplicateKeys.length) addError('DUPLICATE_KEYS', duplicateKeys.join(', '));

if (fs.existsSync(examplePath)) {
    const example = dotenv.parse(fs.readFileSync(examplePath, 'utf8'));
    const missingExampleKeys = Object.keys(example).filter((key) => !(key in env)).sort();
    if (missingExampleKeys.length) {
        notes.push(`Optional/example keys not present: ${missingExampleKeys.join(', ')}`);
    }
}

const printItems = (label, items) => {
    console.log(`${label}: ${items.length}`);
    for (const item of items) console.log(`  - ${item.key}: ${item.message}`);
};

console.log('Production environment audit (values are never displayed)');
console.log(`Defined keys: ${Object.keys(env).length}`);
printItems('Errors', errors);
printItems('Warnings', warnings);
console.log(`Notes: ${notes.length}`);
for (const note of notes) console.log(`  - ${note}`);
console.log(errors.length ? 'RESULT: FAILED' : 'RESULT: PASSED');

process.exitCode = errors.length ? 1 : 0;
