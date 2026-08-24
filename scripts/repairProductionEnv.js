const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const envPath = path.resolve(process.argv[2] || '.env');
const shouldApply = process.argv.includes('--apply');
const assignmentPattern = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/;

if (!fs.existsSync(envPath)) {
    console.error(`Environment file not found: ${envPath}`);
    process.exit(1);
}

const source = fs.readFileSync(envPath, 'utf8');
const newline = source.includes('\r\n') ? '\r\n' : '\n';
let lines = source.replace(/^\uFEFF/, '').split(/\r?\n/);
const changedKeys = new Set();
const addedKeys = new Set();
const deduplicatedKeys = new Set();

const cleanValue = (value) => {
    const trimmed = String(value || '').trim();
    if (trimmed.length >= 2 && trimmed[0] === trimmed[trimmed.length - 1] && ['"', "'"].includes(trimmed[0])) {
        return trimmed.slice(1, -1).trim();
    }
    return trimmed;
};

const placeholderPattern = /your_|change[_-]?me|generate_|placeholder|example\.com|not[_-]?for[_-]?production/i;
const generateSecret = () => crypto.randomBytes(64).toString('hex');

const scan = () => {
    const found = new Map();
    lines.forEach((line, index) => {
        const match = line.match(assignmentPattern);
        if (!match) return;
        const key = match[2];
        if (!found.has(key)) found.set(key, []);
        found.get(key).push({ index, rawValue: match[4] });
    });
    return found;
};

for (const [key, entries] of scan()) {
    if (entries.length < 2) continue;
    const nonEmpty = entries.filter((entry) => cleanValue(entry.rawValue));
    const keepIndex = (nonEmpty.at(-1) || entries.at(-1)).index;
    const removeIndices = new Set(entries.filter((entry) => entry.index !== keepIndex).map((entry) => entry.index));
    lines = lines.filter((_, index) => !removeIndices.has(index));
    deduplicatedKeys.add(key);
}

const currentValue = (key) => {
    const entry = scan().get(key)?.at(-1);
    return entry ? cleanValue(entry.rawValue) : '';
};

const upsert = (key, value, { force = false } = {}) => {
    const entries = scan().get(key) || [];
    if (!entries.length) {
        if (lines.length && lines.at(-1) !== '') lines.push('');
        lines.push(`${key}=${value}`);
        addedKeys.add(key);
        return;
    }

    const entry = entries.at(-1);
    const existing = cleanValue(entry.rawValue);
    if ((!force && existing) || existing === value) return;
    lines[entry.index] = `${key}=${value}`;
    changedKeys.add(key);
};

upsert('NODE_ENV', 'production', { force: true });
upsert('PUBLIC_APP_URL', 'https://ahrampay.com');
upsert('WEB_PUSH_SUBJECT', 'mailto:support@ahrampay.com');
upsert('SECURE_COOKIE', 'true', { force: true });
upsert('COOKIE_SAMESITE', 'lax');
upsert('TRUST_PROXY_HTTPS', 'true', { force: true });

const forcedSecurityValues = {
    PASSWORD_ONLY_LOGIN_MODE: 'true',
    SECURITY_VERIFICATION_ENFORCEMENT_ENABLED: 'false',
    SECURITY_VERIFICATION_MODE: 'optional',
    PASSKEY_REQUIRED: 'false',
    FORCE_CLIENT_OTP: 'false',
    BYPASS_OTP: 'false',
    BYPASS_CLIENT_OTP: 'false',
    DISABLE_OTP: 'false',
    MASTER_OTP: '',
    SESSION_STORE: 'mongo',
    MONGO_TRANSACTIONS_REQUIRED: 'true',
    TENANT_ISOLATION_REQUIRED: 'true',
    ALLOW_LEGACY_TENANTLESS_RECORDS: 'false',
    ALLOW_LEGACY_TENANT_TOKENS: 'false',
    ALLOW_PUBLIC_SYSTEM_MONITOR: 'false',
    ALLOW_LEGACY_SAME_ORIGIN_CSRF: 'false'
};

for (const [key, value] of Object.entries(forcedSecurityValues)) {
    upsert(key, value, { force: true });
}

if (!['single', 'multi'].includes(currentValue('TENANT_MODE').toLowerCase())) {
    upsert('TENANT_MODE', 'single', { force: true });
}
if (!currentValue('DEFAULT_TENANT_ID') && !currentValue('DEFAULT_TENANT_SLUG')) {
    upsert('DEFAULT_TENANT_SLUG', 'ahram');
}

const authenticationSecretKeys = ['JWT_SECRET', 'JWT_REFRESH_SECRET', 'SESSION_SECRET', 'OTP_SECRET'];
const initialAuthenticationSecrets = new Map(
    authenticationSecretKeys.map((key) => [key, currentValue(key)])
);
const authenticationSecretCounts = new Map();

for (const value of initialAuthenticationSecrets.values()) {
    if (!value) continue;
    authenticationSecretCounts.set(value, (authenticationSecretCounts.get(value) || 0) + 1);
}

const generatedSecrets = new Set(
    [...initialAuthenticationSecrets.values()].filter(Boolean)
);
const nextUniqueSecret = () => {
    let value;
    do value = generateSecret(); while (generatedSecrets.has(value));
    generatedSecrets.add(value);
    return value;
};

for (const key of authenticationSecretKeys) {
    const existing = initialAuthenticationSecrets.get(key);
    const invalid = existing.length < 32
        || placeholderPattern.test(existing)
        || authenticationSecretCounts.get(existing) > 1;
    if (invalid) upsert(key, nextUniqueSecret(), { force: true });
}

for (const key of ['RECEIPT_SHARE_SECRET', 'TENANT_ROUTING_SECRET']) {
    const existing = currentValue(key);
    if (existing.length < 32 || placeholderPattern.test(existing)) {
        upsert(key, nextUniqueSecret(), { force: true });
    }
}

const safeDefaults = {
    WHATCHIMP_API_BASE_URL: 'https://app.whatchimp.com/api/v1/whatsapp',
    WHATCHIMP_OTP_TEMPLATE: 'power_pay_otp',
    WHATCHIMP_OTP_TEMPLATE_LANGUAGE: 'ar',
    WHATCHIMP_OTP_VARIABLE_ORDER: 'otp,expiresMinutes',
    WHATCHIMP_RECEIPT_TEMPLATE_LANGUAGE: 'ar',
    WHATCHIMP_RECEIPT_VARIABLE_ORDER: 'accountName,reference,amount,currency,completedAt,receiptUrl',
    WHATCHIMP_RATE_CHANGE_TEMPLATE: 'power_pay_rate_change',
    WHATCHIMP_RATE_CHANGE_TEMPLATE_LANGUAGE: 'ar',
    WHATCHIMP_RATE_CHANGE_VARIABLE_ORDER: 'accountName,countdown,rateChanges,effectiveAt',
    WHATCHIMP_RECEIPT_URL_TTL_HOURS: '720',
    WHATCHIMP_REQUEST_TIMEOUT_MS: '15000',
    API_BALANCE_TOLERANCE: '0.01',
    API_RETURN_MONITOR_ENABLED: 'true',
    API_RETURN_MONITOR_INTERVAL_MS: '300000',
    REDIS_ENABLED: 'false',
    REDIS_REQUIRED: 'false',
    TENANT_ROOT_DOMAIN: 'ahrampay.com',
    GLOBAL_RATE_LIMIT_MAX: '5000',
    ACCESS_TOKEN_TTL_SECONDS: '900'
};

for (const [key, value] of Object.entries(safeDefaults)) upsert(key, value);

const origins = currentValue('ALLOWED_ORIGINS')
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter(Boolean);

for (const requiredOrigin of ['https://ahrampay.com', 'https://www.ahrampay.com']) {
    if (!origins.includes(requiredOrigin)) origins.push(requiredOrigin);
}

try {
    const publicOrigin = new URL(currentValue('PUBLIC_APP_URL')).origin;
    if (!origins.includes(publicOrigin)) origins.push(publicOrigin);
} catch {
    // The audit command reports malformed URLs; this repair only supplies safe defaults.
}

upsert('ALLOWED_ORIGINS', origins.join(','), { force: true });

while (lines.length > 1 && lines.at(-1) === '' && lines.at(-2) === '') lines.pop();
const result = `${lines.join(newline).replace(/(?:\r?\n)*$/, '')}${newline}`;

const printKeys = (label, keys) => {
    const values = [...keys].sort();
    console.log(`${label}: ${values.length}${values.length ? ` (${values.join(', ')})` : ''}`);
};

console.log(`Production environment repair ${shouldApply ? 'applied' : 'preview'} (values are never displayed)`);
printKeys('Added keys', addedKeys);
printKeys('Updated keys', changedKeys);
printKeys('Deduplicated keys', deduplicatedKeys);

if (shouldApply) {
    fs.writeFileSync(envPath, result, { encoding: 'utf8', mode: 0o600 });
    console.log('RESULT: APPLIED');
} else {
    console.log('RESULT: PREVIEW ONLY; rerun with --apply to write changes');
}
