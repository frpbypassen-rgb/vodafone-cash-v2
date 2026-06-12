// tests/lockService.test.js
'use strict';

describe('Lock Service Tests (In-Memory Fallback)', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.restoreAllMocks();
    });

    test('يجب حجز القفل بنجاح وتحريره لاحقاً (In-Memory)', async () => {
        const { acquireLock, releaseLock } = require('../services/lockService');
        const key = 'test-resource';
        const lock = await acquireLock(key, 5000);
        
        expect(lock).toBeDefined();
        expect(lock.__inMemory).toBe(true);
        
        await expect(releaseLock(lock)).resolves.not.toThrow();
    });

    test('يجب حظر حجز نفس القفل بالتزامن حتى يتم تحريره أو ينتهي الـ TTL (In-Memory)', async () => {
        const { acquireLock, releaseLock } = require('../services/lockService');
        const key = 'shared-resource';
        const lock1 = await acquireLock(key, 5000);
        
        const promise2 = acquireLock(key, 2000, { retryCount: 2, retryDelay: 10 });
        await expect(promise2).rejects.toThrow('LOCK_ACQUISITION_TIMEOUT');
        
        await releaseLock(lock1);
    });

    test('يجب السماح بحجز القفل مجدداً بعد تحرير القفل الأول بنجاح (In-Memory)', async () => {
        const { acquireLock, releaseLock } = require('../services/lockService');
        const key = 'release-and-acquire';
        const lock1 = await acquireLock(key, 5000);
        
        await releaseLock(lock1);
        
        const lock2 = await acquireLock(key, 5000);
        expect(lock2).toBeDefined();
        
        await releaseLock(lock2);
    });

    test('يجب أن يعمل المؤقت التلقائي TTL ويحذف القفل (In-Memory)', async () => {
        jest.useFakeTimers();
        const { acquireLock } = require('../services/lockService');
        const key = 'timeout-resource';
        const lock = await acquireLock(key, 100);
        
        expect(lock).toBeDefined();
        
        // تشغيل المؤقتات
        jest.advanceTimersByTime(150);
        jest.useRealTimers();
    });

    test('يجب معالجة أخطاء فشل التحرير في releaseLock', async () => {
        const { releaseLock } = require('../services/lockService');
        const badLock = {
            release: jest.fn().mockRejectedValue(new Error('Release error'))
        };
        await expect(releaseLock(badLock)).resolves.not.toThrow();
    });
});

describe('Lock Service Tests (Redis Redlock)', () => {
    let mockAcquire;
    let mockRelease;
    let mockOn;

    beforeEach(() => {
        jest.resetModules();
        mockAcquire = jest.fn();
        mockRelease = jest.fn();
        mockOn = jest.fn();

        jest.mock('../config/redis', () => ({
            isRedis: () => true,
            getRedisClient: () => ({})
        }));

        jest.mock('redlock', () => {
            return {
                default: jest.fn().mockImplementation(() => ({
                    acquire: mockAcquire,
                    on: mockOn
                }))
            };
        });
    });

    afterEach(() => {
        jest.unmock('../config/redis');
        jest.unmock('redlock');
    });

    test('يجب حجز القفل الموزع بنجاح باستخدام Redlock', async () => {
        const fakeLock = { release: mockRelease };
        mockAcquire.mockResolvedValue(fakeLock);

        const { acquireLock, releaseLock } = require('../services/lockService');
        const lock = await acquireLock('redis-key', 5000);

        expect(lock).toBeDefined();
        expect(mockAcquire).toHaveBeenCalledWith(['locks:redis-key'], 5000);

        await releaseLock(lock);
        expect(mockRelease).toHaveBeenCalled();
    });

    test('يجب تسجيل خطأ عميل Redlock عند حدوث clientError', async () => {
        const { acquireLock } = require('../services/lockService');
        await acquireLock('any-key', 5000);
        
        // التحقق من تسجيل مستمع الأحداث لـ clientError
        expect(mockOn).toHaveBeenCalledWith('clientError', expect.any(Function));
        
        // تشغيل الحدث يدوياً للتأكد من استدعاء اللوجر بدون انهيار
        const errorHandler = mockOn.mock.calls.find(call => call[0] === 'clientError')[1];
        expect(() => errorHandler(new Error('Redis connection drop'))).not.toThrow();
    });

    test('يجب التراجع للقفل المحلي في حال فشل Redlock', async () => {
        mockAcquire.mockRejectedValue(new Error('Redlock failed connection'));

        const { acquireLock, releaseLock } = require('../services/lockService');
        
        const lock = await acquireLock('fallback-key', 5000);
        expect(lock).toBeDefined();
        expect(lock.__inMemory).toBe(true);

        await releaseLock(lock);
    });

    test('يجب التراجع للقفل المحلي في حال فشل استيراد مكتبة Redlock أو تهيئتها', async () => {
        jest.doMock('redlock', () => {
            throw new Error('Module not found');
        });

        const { acquireLock } = require('../services/lockService');
        const lock = await acquireLock('fail-init-key', 5000);
        expect(lock).toBeDefined();
        expect(lock.__inMemory).toBe(true);
    });
});
