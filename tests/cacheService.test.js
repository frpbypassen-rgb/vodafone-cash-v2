// tests/cacheService.test.js
'use strict';

const {
    cacheSettings,
    cacheExchangeRate,
    cacheOTP,
    verifyOTP,
    rateLimitByKey,
    invalidateAll
} = require('../services/cacheService');

const { getRedisClient } = require('../config/redis');

describe('Cache Service Tests', () => {

    beforeEach(async () => {
        // تفريغ الكاش بالكامل قبل كل اختبار
        await invalidateAll();
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('Settings Caching (cacheSettings)', () => {
        test('يجب أن تقوم بحفظ وجلب الإعدادات بنجاح من التخزين المؤقت', async () => {
            const mockSettings = { isManualClosed: false, rateLevel1: 6.2 };
            
            // جلب لأول مرة (يجب أن يكون null)
            const initial = await cacheSettings();
            expect(initial).toBeNull();

            // حفظ
            const saved = await cacheSettings(mockSettings);
            expect(saved).toEqual(mockSettings);

            // جلب مرة أخرى (يجب أن يرجع نفس القيم)
            const cached = await cacheSettings();
            expect(cached).toEqual(mockSettings);
        });

        test('يجب أن تنتهي صلاحية الإعدادات بعد مرور 60 ثانية', async () => {
            const mockSettings = { isManualClosed: true };
            await cacheSettings(mockSettings);

            // تقديم الوقت 61 ثانية
            jest.advanceTimersByTime(61000);

            const cached = await cacheSettings();
            expect(cached).toBeNull();
        });
    });

    describe('Exchange Rate Caching (cacheExchangeRate)', () => {
        test('يجب حفظ وجلب أسعار الصرف لكل مستوى بشكل مستقل', async () => {
            await cacheExchangeRate(1, 6.25);
            await cacheExchangeRate(2, 6.35);

            expect(await cacheExchangeRate(1)).toBe(6.25);
            expect(await cacheExchangeRate(2)).toBe(6.35);
            expect(await cacheExchangeRate(3)).toBeNull(); // لم يتم تعيينه
        });

        test('يجب أن ينتهي كاش سعر الصرف بعد 30 ثانية', async () => {
            await cacheExchangeRate(1, 6.40);
            
            jest.advanceTimersByTime(31000);

            const cached = await cacheExchangeRate(1);
            expect(cached).toBeNull();
        });
    });

    describe('OTP Verification (cacheOTP & verifyOTP)', () => {
        test('يجب حفظ رمز OTP بنجاح والتحقق منه لمرة واحدة فقط', async () => {
            const phone = '0912345678';
            const otp = '123456';

            await cacheOTP(phone, otp);

            // التحقق برمز خاطئ
            const badVerify = await verifyOTP(phone, '000000');
            expect(badVerify.valid).toBe(false);
            expect(badVerify.reason).toBe('MISMATCH');

            // التحقق برمز صحيح
            const goodVerify = await verifyOTP(phone, otp);
            expect(goodVerify.valid).toBe(true);

            // محاولة التحقق بالرمز الصحيح مرة ثانية (يجب أن يفشل لأنه حُذف بعد الاستخدام)
            const secondVerify = await verifyOTP(phone, otp);
            expect(secondVerify.valid).toBe(false);
            expect(secondVerify.reason).toBe('EXPIRED');
        });

        test('يجب أن ينتهي رمز OTP بعد 5 دقائق (300 ثانية) افتراضياً', async () => {
            const phone = '0922222222';
            await cacheOTP(phone, '999999');

            // تقديم الوقت 301 ثانية
            jest.advanceTimersByTime(301000);

            const verify = await verifyOTP(phone, '999999');
            expect(verify.valid).toBe(false);
            expect(verify.reason).toBe('EXPIRED');
        });
    });

    describe('Rate Limiting (rateLimitByKey)', () => {
        test('يجب السماح بالطلبات ضمن الحد ورفضها عند تجاوز الحد الأقصى', async () => {
            const key = 'user:123:endpoint';
            const maxRequests = 3;
            const windowSeconds = 10;

            // الطلب الأول
            let rl = await rateLimitByKey(key, maxRequests, windowSeconds);
            expect(rl.allowed).toBe(true);
            expect(rl.remaining).toBe(2);
            expect(rl.retryAfter).toBe(0);

            // الطلب الثاني
            rl = await rateLimitByKey(key, maxRequests, windowSeconds);
            expect(rl.allowed).toBe(true);
            expect(rl.remaining).toBe(1);

            // الطلب الثالث
            rl = await rateLimitByKey(key, maxRequests, windowSeconds);
            expect(rl.allowed).toBe(true);
            expect(rl.remaining).toBe(0);

            // الطلب الرابع (تجاوز الحد)
            rl = await rateLimitByKey(key, maxRequests, windowSeconds);
            expect(rl.allowed).toBe(false);
            expect(rl.remaining).toBe(0);
            expect(rl.retryAfter).toBe(windowSeconds);
        });

        test('يجب تصفير معدل الطلبات بعد انتهاء النافذة الزمنية', async () => {
            const key = 'ip:127.0.0.1';
            await rateLimitByKey(key, 1, 5);

            // تجاوز الحد مباشرة
            let rl = await rateLimitByKey(key, 1, 5);
            expect(rl.allowed).toBe(false);

            // تقديم الوقت 6 ثوانٍ
            jest.advanceTimersByTime(6000);

            // الطلب بعد انتهاء النافذة الزمنية (يجب أن يُسمح به مجدداً)
            rl = await rateLimitByKey(key, 1, 5);
            expect(rl.allowed).toBe(true);
            expect(rl.remaining).toBe(0);
        });
    });

    describe('Invalidate All (invalidateAll)', () => {
        test('يجب أن تقوم بمسح كافة المفاتيح المخزنة في الكاش', async () => {
            await cacheSettings({ isClosed: false });
            await cacheExchangeRate(1, 6.0);

            await invalidateAll();

            expect(await cacheSettings()).toBeNull();
            expect(await cacheExchangeRate(1)).toBeNull();
        });
    });
});
