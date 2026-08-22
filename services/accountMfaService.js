'use strict';

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const TrustedDevice = require('../models/TrustedDevice');
const User = require('../models/User');
const SubAccount = require('../models/SubAccount');
const ClientEmployee = require('../models/ClientEmployee');
const Employee = require('../models/Employee');
const AgentEmployee = require('../models/AgentEmployee');
const Admin = require('../models/Admin');
const { JWT_SECRET } = require('../middlewares/jwtAuth');

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TRUST_TTL_MS = Math.max(60 * 60 * 1000, Number(process.env.MFA_TRUST_TTL_SECONDS || 86400) * 1000);
const CHALLENGE_TTL_SECONDS = Math.max(60, Number(process.env.MFA_CHALLENGE_TTL_SECONDS || 300));
const ISSUER = String(process.env.MFA_ISSUER || 'Al-Ahram Pay').trim();

const ACCOUNT_TYPE_ALIASES = Object.freeze({
    user: 'client_user',
    client: 'client_user',
    agent: 'client_user',
    company: 'client_company',
    client_user: 'client_user',
    sub_client: 'sub_client',
    client_company: 'client_company',
    executor: 'executor',
    agent_staff: 'agent_staff',
    admin: 'admin'
});

const normalizeAccountType = (accountType) => (
    ACCOUNT_TYPE_ALIASES[String(accountType || '').trim().toLowerCase()] || 'client_user'
);

const modelFor = (accountType) => ({
    client_user: User,
    sub_client: SubAccount,
    client_company: ClientEmployee,
    executor: Employee,
    agent_staff: AgentEmployee,
    admin: Admin
}[normalizeAccountType(accountType)] || User);

const loadAccount = (accountType, accountId, tenantId) => {
    const canonicalType = normalizeAccountType(accountType);
    const Model = modelFor(canonicalType);
    const filter = { _id: accountId };
    if (tenantId && Model.schema && typeof Model.schema.path === 'function' && Model.schema.path('tenantId')) {
        filter.tenantId = tenantId;
    }
    const query = tenantId && filter.tenantId ? Model.findOne(filter) : Model.findById(accountId);
    return query && typeof query.select === 'function'
        ? query.select('+totpSecretEncrypted +mfaRecoveryCodeHashes')
        : query;
};

const accountTypeForModel = (account) => normalizeAccountType({
    User: 'client_user',
    SubAccount: 'sub_client',
    ClientEmployee: 'client_company',
    Employee: 'executor',
    AgentEmployee: 'agent_staff',
    Admin: 'admin'
}[String(account?.$modelName || account?.constructor?.modelName || 'User')] || 'client_user');

const encryptionKey = () => {
    const raw = String(process.env.MFA_ENCRYPTION_KEY || '').trim();
    if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
    if (/^[A-Za-z0-9+/]{43}=?$/.test(raw)) return Buffer.from(raw, 'base64');
    // Development fallback keeps local previews usable. Production must set a
    // dedicated key and is rejected by the environment audit.
    return crypto.createHash('sha256').update(String(process.env.JWT_SECRET || 'mfa-dev-key')).digest();
};

const encrypt = (value) => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
    const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`;
};

const decrypt = (value) => {
    const [ivRaw, tagRaw, ciphertextRaw] = String(value || '').split('.');
    if (!ivRaw || !tagRaw || !ciphertextRaw) return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivRaw, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, 'base64url')), decipher.final()]).toString('utf8');
};

const hash = (value) => crypto.createHash('sha256').update(String(value || '')).digest('hex');
const normalizeToken = (value) => String(value || '').replace(/\D/g, '').slice(0, 6);

const generateSecret = (length = 20) => {
    let secret = '';
    for (let i = 0; i < length; i += 1) secret += BASE32[crypto.randomInt(0, BASE32.length)];
    return secret;
};

const base32Decode = (input) => {
    const clean = String(input || '').toUpperCase().replace(/=+$/, '');
    let buffer = 0;
    let bits = 0;
    const bytes = [];
    for (const char of clean) {
        const value = BASE32.indexOf(char);
        if (value < 0) throw new Error('INVALID_TOTP_SECRET');
        buffer = (buffer << 5) | value;
        bits += 5;
        if (bits >= 8) {
            bytes.push((buffer >> (bits - 8)) & 0xff);
            bits -= 8;
        }
    }
    return Buffer.from(bytes);
};

const hotp = (secret, counter) => {
    const counterBuffer = Buffer.alloc(8);
    let value = BigInt(counter);
    for (let i = 7; i >= 0; i -= 1) {
        counterBuffer[i] = Number(value & 0xffn);
        value >>= 8n;
    }
    const digest = crypto.createHmac('sha1', base32Decode(secret)).update(counterBuffer).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const code = ((digest[offset] & 0x7f) << 24)
        | ((digest[offset + 1] & 0xff) << 16)
        | ((digest[offset + 2] & 0xff) << 8)
        | (digest[offset + 3] & 0xff);
    return String(code % 1000000).padStart(6, '0');
};

const verifyTotp = (secret, token, window = 1) => {
    const clean = normalizeToken(token);
    if (!/^\d{6}$/.test(clean)) return false;
    const current = Math.floor(Date.now() / 1000 / 30);
    return Array.from({ length: window * 2 + 1 }, (_, index) => current + index - window)
        .some((counter) => crypto.timingSafeEqual(Buffer.from(hotp(secret, counter)), Buffer.from(clean)));
};

const recoveryCodes = (count = 8) => Array.from({ length: count }, () => {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
});

const recoveryHash = (code) => hash(String(code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase());

const qrUri = (secret, username) => `otpauth://totp/${encodeURIComponent(ISSUER)}:${encodeURIComponent(username)}?secret=${secret}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=6&period=30`;

const isEnabled = (account) => Boolean(account?.mfaEnabled && account?.mfaType === 'totp' && account?.totpSecretEncrypted);

const setup = (account) => {
    const secret = generateSecret();
    const codes = recoveryCodes();
    return {
        secret,
        qrUri: qrUri(secret, account.webUsername || account.phone || String(account._id)),
        recoveryCodes: codes,
        recoveryCodeHashes: codes.map(recoveryHash)
    };
};

const confirmSetup = async (account, secret, token, codes) => {
    if (!verifyTotp(secret, token, 1)) {
        const error = new Error('MFA_INVALID');
        error.code = 'MFA_INVALID';
        throw error;
    }
    account.mfaEnabled = true;
    account.mfaType = 'totp';
    account.totpSecretEncrypted = encrypt(secret);
    account.mfaRecoveryCodeHashes = (Array.isArray(codes) && codes.length ? codes : recoveryCodes()).map(recoveryHash);
    account.mfaConfiguredAt = new Date();
    account.mfaLastUsedStep = null;
    await account.save();
    return { enabled: true };
};

const disable = async (account, token) => {
    if (!isEnabled(account)) return { enabled: false };
    const validTotp = verifyTotp(decrypt(account.totpSecretEncrypted), token, 1);
    const codeHash = recoveryHash(token);
    const recoveryIndex = Array.isArray(account.mfaRecoveryCodeHashes)
        ? account.mfaRecoveryCodeHashes.findIndex((item) => item === codeHash)
        : -1;
    if (!validTotp && recoveryIndex < 0) {
        const error = new Error('MFA_INVALID');
        error.code = 'MFA_INVALID';
        throw error;
    }
    if (recoveryIndex >= 0) account.mfaRecoveryCodeHashes.splice(recoveryIndex, 1);
    account.mfaEnabled = false;
    account.mfaType = 'none';
    account.totpSecretEncrypted = undefined;
    account.mfaRecoveryCodeHashes = [];
    account.mfaConfiguredAt = null;
    await account.save();
    await TrustedDevice.updateMany({ accountId: account._id, active: true }, { $set: { active: false, revokedAt: new Date(), revokeReason: 'mfa_disabled' } });
    return { enabled: false };
};

const verifyAccountToken = (account, token) => {
    if (!isEnabled(account)) return true;
    const secret = decrypt(account.totpSecretEncrypted);
    if (verifyTotp(secret, token, 1)) return true;
    const codeHash = recoveryHash(token);
    const index = Array.isArray(account.mfaRecoveryCodeHashes)
        ? account.mfaRecoveryCodeHashes.findIndex((item) => item === codeHash)
        : -1;
    if (index < 0) return false;
    account.mfaRecoveryCodeHashes.splice(index, 1);
    return account.save().then(() => true);
};

const deviceIdFor = (req) => String(req?.headers?.['x-device-id'] || '').trim().slice(0, 200) || hash(`${req?.headers?.['user-agent'] || ''}|${req?.ip || ''}`);

const trustDevice = async ({ account, accountType, tenantId, deviceId, sessionId, req }) => {
    const canonicalType = normalizeAccountType(accountType);
    const deviceIdHash = hash(deviceId);
    await TrustedDevice.updateMany({ accountId: account._id, accountType: canonicalType, active: true }, { $set: { active: false, revokedAt: new Date(), revokeReason: 'replaced_by_new_device' } });
    return TrustedDevice.create({
        accountId: account._id,
        accountType: canonicalType,
        tenantId: tenantId || null,
        deviceIdHash,
        sessionId: sessionId || null,
        deviceType: String(req?.headers?.['x-device-type'] || 'هاتف').slice(0, 40),
        userAgent: String(req?.headers?.['user-agent'] || '').slice(0, 300),
        expiresAt: new Date(Date.now() + TRUST_TTL_MS)
    });
};

const isDeviceTrusted = async ({ account, accountType, deviceId, sessionId }) => {
    if (!TrustedDevice || typeof TrustedDevice.findOne !== 'function') return false;
    const query = { accountId: account._id, accountType: normalizeAccountType(accountType), active: true, expiresAt: { $gt: new Date() }, deviceIdHash: hash(deviceId) };
    if (sessionId) query.sessionId = sessionId;
    const record = await TrustedDevice.findOne(query);
    if (record) await TrustedDevice.updateOne({ _id: record._id }, { $set: { lastSeenAt: new Date() } });
    return Boolean(record);
};

const createChallenge = ({ account, accountType, tenantId, deviceId }) => jwt.sign({ kind: 'mfa-login', userId: String(account._id), accountType: normalizeAccountType(accountType), tenantId: tenantId || null, deviceIdHash: hash(deviceId) }, JWT_SECRET, { expiresIn: CHALLENGE_TTL_SECONDS });
const verifyChallenge = (token) => {
    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.kind !== 'mfa-login') throw new Error('MFA_CHALLENGE_INVALID');
    return payload;
};

const status = (account) => ({
    enabled: isEnabled(account),
    type: isEnabled(account) ? 'totp' : 'none',
    configuredAt: account.mfaConfiguredAt || null,
    trustTtlSeconds: Math.floor(TRUST_TTL_MS / 1000)
});

module.exports = {
    normalizeAccountType,
    modelFor,
    loadAccount,
    accountTypeForModel,
    setup,
    confirmSetup,
    disable,
    verifyAccountToken,
    isEnabled,
    status,
    deviceIdFor,
    trustDevice,
    isDeviceTrusted,
    createChallenge,
    verifyChallenge,
    decrypt,
    verifyTotp,
    TRUST_TTL_MS
};
