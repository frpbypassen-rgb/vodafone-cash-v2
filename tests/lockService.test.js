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

    test('an expired memory owner cannot release a newer owner of the same key', async () => {
        jest.useFakeTimers();
        try {
            const { acquireLock, releaseLock } = require('../services/lockService');
            const first = await acquireLock('expired-owner', 100);
            jest.advanceTimersByTime(101);
            const second = await acquireLock('expired-owner', 1000);
            await releaseLock(first);
            const attempt = acquireLock('expired-owner', 1000, { retryCount: 1, retryDelay: 1 });
            const assertion = expect(attempt).rejects.toThrow('LOCK_ACQUISITION_TIMEOUT');
            await jest.advanceTimersByTimeAsync(2);
            await assertion;
            await releaseLock(second);
        } finally { jest.useRealTimers(); }
    });

    test('fails closed in production even when Redis is marked optional', async () => {
        const originalNodeEnv = process.env.NODE_ENV;
        const originalRedisRequired = process.env.REDIS_REQUIRED;
        process.env.NODE_ENV = 'production';
        process.env.REDIS_REQUIRED = 'false';

        jest.resetModules();
        jest.doMock('../config/redis', () => ({
            isRedis: () => false,
            getRedisClient: () => ({})
        }));

        try {
            const { acquireLock } = require('../services/lockService');
            await expect(acquireLock('optional-redis-production', 5000))
                .rejects.toThrow('REDIS_NOT_CONFIGURED');
        } finally {
            if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
            else process.env.NODE_ENV = originalNodeEnv;
            if (originalRedisRequired === undefined) delete process.env.REDIS_REQUIRED;
            else process.env.REDIS_REQUIRED = originalRedisRequired;
        }
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
        expect(mockAcquire).toHaveBeenCalledWith(['locks:redis-key'], 5000, expect.objectContaining({ retryCount: 15, retryDelay: 150 }));

        await releaseLock(lock);
        expect(mockRelease).toHaveBeenCalled();
    });

    test('handles the Redlock v5 error event instead of an unused clientError event', async () => {
        const { acquireLock } = require('../services/lockService');
        await acquireLock('any-key', 5000);
        
        // التحقق من تسجيل مستمع الأحداث لـ clientError
        expect(mockOn).toHaveBeenCalledWith('error', expect.any(Function));
        
        // تشغيل الحدث يدوياً للتأكد من استدعاء اللوجر بدون انهيار
        const errorHandler = mockOn.mock.calls.find(call => call[0] === 'error')[1];
        expect(() => errorHandler(new Error('Redis connection drop'))).not.toThrow();
    });

    test('forwards per-request retry settings to Redlock', async () => {
        mockAcquire.mockResolvedValue({ release: mockRelease });
        await require('../services/lockService').acquireLock('fast-lock', 45000, { retryCount: 2, retryDelay: 100 });
        expect(mockAcquire).toHaveBeenCalledWith(['locks:fast-lock'], 45000, expect.objectContaining({ retryCount: 2, retryDelay: 100 }));
    });

    test('a genuine Redis contention never falls back to a second independent memory lock', async () => {
        const busy = Object.assign(new Error('held'), { name: 'ResourceLockedError' });
        mockAcquire.mockRejectedValue(Object.assign(new Error('quorum'), { name: 'ExecutionError',
            attempts: [Promise.resolve({ votesAgainst: new Map([[{}, busy]]) })] }));
        await expect(require('../services/lockService').acquireLock('held-resource', 5000))
            .rejects.toMatchObject({ code: 'LOCK_BUSY' });
    });

    test('initialization failure cannot silently use a memory lock in production', async () => {
        const original = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        jest.doMock('redlock', () => { throw new Error('module unavailable'); });
        try {
            await expect(require('../services/lockService').acquireLock('production-init', 5000))
                .rejects.toMatchObject({ code: 'LOCK_UNAVAILABLE' });
        } finally { process.env.NODE_ENV = original; }
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
