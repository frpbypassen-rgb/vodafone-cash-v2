// tests/encryption.test.js
// ===============================================
// 🔐 Encryption Module Unit Tests
// ===============================================

describe('🔐 Encryption Module (AES-256-GCM)', () => {
    let encryption;

    beforeAll(() => {
        process.env.JWT_SECRET = 'test-secret-key-for-encryption-32chars-long-enough';
        encryption = require('../utils/encryption');
    });

    test('✅ encrypt() يُنتج نص مشفر بتنسيق iv:data:tag', () => {
        const result = encryption.encrypt('hello-world');
        expect(result).toContain(':');
        const parts = result.split(':');
        expect(parts).toHaveLength(3);
        expect(parts[0]).toHaveLength(32); // IV = 16 bytes = 32 hex
        expect(parts[2]).toHaveLength(32); // Tag = 16 bytes = 32 hex
    });

    test('✅ decrypt() يُعيد النص الأصلي', () => {
        const original = 'sensitive-bot-token-123456:ABC-DEF';
        const encrypted = encryption.encrypt(original);
        const decrypted = encryption.decrypt(encrypted);
        expect(decrypted).toBe(original);
    });

    test('✅ encrypt() ينتج نتائج مختلفة لنفس النص (IV عشوائي)', () => {
        const text = 'same-text';
        const enc1 = encryption.encrypt(text);
        const enc2 = encryption.encrypt(text);
        expect(enc1).not.toBe(enc2);
        // لكن كلاهما يُفك لنفس النص
        expect(encryption.decrypt(enc1)).toBe(text);
        expect(encryption.decrypt(enc2)).toBe(text);
    });

    test('✅ encrypt() يحمي من التشفير المزدوج', () => {
        const original = 'api-key-12345';
        const encrypted = encryption.encrypt(original);
        const doubleEncrypted = encryption.encrypt(encrypted);
        // يجب أن يُرجع نفس النص المشفر (لا يُشفر مرتين)
        expect(doubleEncrypted).toBe(encrypted);
    });

    test('✅ decrypt() يُعيد النص كما هو إذا لم يكن مشفراً', () => {
        const plaintext = 'just-a-normal-string';
        const result = encryption.decrypt(plaintext);
        expect(result).toBe(plaintext);
    });

    test('✅ isEncrypted() يكتشف النصوص المشفرة بدقة', () => {
        expect(encryption.isEncrypted(null)).toBe(false);
        expect(encryption.isEncrypted('')).toBe(false);
        expect(encryption.isEncrypted('not-encrypted')).toBe(false);
        
        const encrypted = encryption.encrypt('test');
        expect(encryption.isEncrypted(encrypted)).toBe(true);
    });

    test('✅ hashForLog() يُنتج hash مقتطع للـ logging', () => {
        const hash = encryption.hashForLog('secret-data');
        expect(hash).toMatch(/^[0-9a-f]{8}\.\.\.$/);
        expect(hash).toHaveLength(11); // 8 chars + "..."
    });

    test('✅ encrypt/decrypt يتعامل مع null و undefined', () => {
        expect(encryption.encrypt(null)).toBeNull();
        expect(encryption.encrypt(undefined)).toBeUndefined();
        expect(encryption.decrypt(null)).toBeNull();
        expect(encryption.decrypt(undefined)).toBeUndefined();
    });

    test('✅ يدعم النصوص العربية والرموز الخاصة', () => {
        const arabic = 'مفتاح API سري 🔑 مع رموز: @#$%^&*()';
        const encrypted = encryption.encrypt(arabic);
        const decrypted = encryption.decrypt(encrypted);
        expect(decrypted).toBe(arabic);
    });
});
