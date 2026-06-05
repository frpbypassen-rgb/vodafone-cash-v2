// utils/encryption.js
// ===============================================
// 🔐 AES-256-GCM Encryption for Sensitive Fields
// ===============================================

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const ENCODING = 'hex';

/**
 * Get encryption key from environment (must be 64 hex chars = 32 bytes)
 * Falls back to deriving from JWT_SECRET if ENCRYPTION_KEY not set
 */
function getKey() {
    if (process.env.ENCRYPTION_KEY) {
        const key = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
        if (key.length !== 32) throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
        return key;
    }
    // Derive from JWT_SECRET as fallback
    const secret = process.env.JWT_SECRET || 'default-fallback-key-not-for-production';
    return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt a plaintext string using AES-256-GCM
 * @param {string} plaintext - Text to encrypt
 * @returns {string} Encrypted string in format: iv:encrypted:tag (hex)
 */
function encrypt(plaintext) {
    if (!plaintext || typeof plaintext !== 'string') return plaintext;
    
    // Don't double-encrypt
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
 * Decrypt an encrypted string
 * @param {string} encryptedText - Text in format: iv:encrypted:tag
 * @returns {string} Decrypted plaintext
 */
function decrypt(encryptedText) {
    if (!encryptedText || typeof encryptedText !== 'string') return encryptedText;
    
    // Not encrypted, return as-is
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

/**
 * Check if a string looks like it's already encrypted (iv:data:tag format)
 * @param {string} text - Text to check
 * @returns {boolean}
 */
function isEncrypted(text) {
    if (!text || typeof text !== 'string') return false;
    const parts = text.split(':');
    if (parts.length !== 3) return false;
    // IV should be 32 hex chars, tag should be 32 hex chars
    return parts[0].length === IV_LENGTH * 2 && 
           parts[2].length === TAG_LENGTH * 2 &&
           /^[0-9a-f]+$/i.test(parts[0]) &&
           /^[0-9a-f]+$/i.test(parts[2]);
}

/**
 * Hash sensitive data for logging (one-way, non-reversible)
 * @param {string} text - Text to hash
 * @returns {string} First 8 chars of SHA-256 hash
 */
function hashForLog(text) {
    if (!text) return '***';
    return crypto.createHash('sha256').update(String(text)).digest('hex').substring(0, 8) + '...';
}

module.exports = {
    encrypt,
    decrypt,
    isEncrypted,
    hashForLog
};
