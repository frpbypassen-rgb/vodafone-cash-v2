// utils/encryption.js
// ===============================================
// 🔐 AES-256-GCM Encryption for Sensitive Fields
// Purpose-specific key: ENCRYPTION_KEY only. Never JWT_SECRET.
// ===============================================

const crypto = require('crypto');
const { isLocalRuntime, isSecureRuntime } = require('./runtimeEnv');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const ENCODING = 'hex';
const LOCAL_DEV_ONLY_KEY_MATERIAL = 'local-dev-encryption-key-not-for-production';

const assertHexKey = (value, name) => {
    const hex = String(value || '').trim();
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
        throw new Error(`${name} must be 64 hex characters (32 bytes)`);
    }
    return Buffer.from(hex, 'hex');
};

/**
 * Encryption key for recoverable secrets (provider passwords, webhook HMAC, TOTP).
 * Staging/production require ENCRYPTION_KEY. JWT_SECRET is never used.
 */
function getEncryptionKey(env = process.env) {
    if (env.ENCRYPTION_KEY) {
        return assertHexKey(env.ENCRYPTION_KEY, 'ENCRYPTION_KEY');
    }
    if (isSecureRuntime(env)) {
        throw new Error('ENCRYPTION_KEY is required in staging and production.');
    }
    if (!isLocalRuntime(env)) {
        throw new Error('ENCRYPTION_KEY is required outside local development and test.');
    }
    return crypto.createHash('sha256').update(LOCAL_DEV_ONLY_KEY_MATERIAL).digest();
}

function getKey() {
    return getEncryptionKey();
}

/**
 * Encrypt a plaintext string using AES-256-GCM
 * @param {string} plaintext - Text to encrypt
 * @returns {string} Encrypted string in format: iv:encrypted:tag (hex)
 */
function encrypt(plaintext) {
    if (!plaintext || typeof plaintext !== 'string') return plaintext;

    if (isEncrypted(plaintext)) return plaintext;

    const key = getKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', ENCODING);
    encrypted += cipher.final(ENCODING);

    const tag = cipher.getAuthTag();

    return `${iv.toString(ENCODING)}:${encrypted}:${tag.toString(ENCODING)}`;
}

/**
 * Decrypt an encrypted string. Legacy plaintext is returned unchanged.
 * @param {string} encryptedText - Text in format: iv:encrypted:tag
 * @returns {string} Decrypted plaintext
 */
function decrypt(encryptedText) {
    if (!encryptedText || typeof encryptedText !== 'string') return encryptedText;

    if (!isEncrypted(encryptedText)) return encryptedText;

    const parts = encryptedText.split(':');
    if (parts.length !== 3) return encryptedText;

    const key = getKey();
    const iv = Buffer.from(parts[0], ENCODING);
    const encrypted = parts[1];
    const tag = Buffer.from(parts[2], ENCODING);

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(encrypted, ENCODING, 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}

function isEncrypted(text) {
    if (!text || typeof text !== 'string') return false;
    const parts = text.split(':');
    if (parts.length !== 3) return false;
    return parts[0].length === IV_LENGTH * 2
        && parts[2].length === TAG_LENGTH * 2
        && /^[0-9a-f]+$/i.test(parts[0])
        && /^[0-9a-f]+$/i.test(parts[2]);
}

function hashForLog(text) {
    if (!text) return '***';
    return crypto.createHash('sha256').update(String(text)).digest('hex').substring(0, 8) + '...';
}

function encryptIfPresent(value) {
    if (!value || typeof value !== 'string') return value;
    return encrypt(value);
}

function applyEncryptedFields(update, fields) {
    if (!update || typeof update !== 'object') return update;
    const target = update.$set && typeof update.$set === 'object' ? update.$set : update;
    for (const field of fields) {
        if (Object.prototype.hasOwnProperty.call(target, field) && target[field]) {
            target[field] = encrypt(String(target[field]));
        }
    }
    return update;
}

module.exports = {
    applyEncryptedFields,
    decrypt,
    encrypt,
    encryptIfPresent,
    getEncryptionKey,
    hashForLog,
    isEncrypted
};
