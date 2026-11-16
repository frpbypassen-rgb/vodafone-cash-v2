// services/lockService.js
// ===============================================
// 🔒 خدمة قفل التوزيع — Distributed Lock Service
// ===============================================
'use strict';

const { getRedisClient, isRedis } = require('../config/redis');
const logger = require('../utils/logger');
const { distributedStateRequired } = require('../config/runtimeScale');

let redlock = null;
let hasWarnedAboutMemoryFallback = false;

const isRedisRequired = () => distributedStateRequired();

const warnAboutMemoryFallback = (message, metadata = {}) => {
    if (hasWarnedAboutMemoryFallback) return;
    hasWarnedAboutMemoryFallback = true;
    logger.warn(message, metadata);
};

// تهيئة Redlock إذا كان Redis متاحاً
const _initRedlock = () => {
    if (redlock) return redlock;
    
    try {
        const RedlockClass = require('redlock').default || require('redlock');
        const client = getRedisClient();
        
        redlock = new RedlockClass(
            [client],
            {
                driftFactor: 0.01,
                retryCount: 15,
                retryDelay: 150, // ميلي ثانية بين المحاولات
                retryJitter: 100,
                automaticExtensionThreshold: 500
            }
        );

        redlock.on('error', (err) => {
            // Redlock v5 reports infrastructure failures on `error`; listening
            // to `clientError` hides the underlying failure from diagnostics.
            if (err.name !== 'ResourceLockedError') logger.error('Redlock client error', { error: err.message });
        });

        logger.info('✅ Redlock initialized successfully');
        return redlock;
    } catch (e) {
        logger.warn('⚠️ Failed to initialize Redlock, falling back to In-Memory locks', { error: e.message });
        return null;
    }
};

// ── In-Memory Lock Fallback (للبيئات المحلية بدون Redis) ──────
const _inMemoryLocks = new Map();

const lockError = (code, message, cause, retryAfterSeconds) => Object.assign(new Error(message, { cause }), {
    code, retryAfterSeconds, statusCode: code === 'LOCK_BUSY' ? 429 : 503,
    publicMessage: code === 'LOCK_BUSY' ? 'يوجد طلب آخر قيد المعالجة. تحقق من حالته قبل إعادة المحاولة.' : 'خدمة حماية التحويل غير متاحة مؤقتًا. لم يُرسل هذا الطلب؛ تحقق من سجل العمليات قبل إعادة المحاولة.'
});

const isContention = async (error) => {
    if (error?.name === 'ResourceLockedError') return true;
    if (error?.name !== 'ExecutionError' || !Array.isArray(error.attempts)) return false;
    const attempts = await Promise.all(error.attempts);
    const failures = attempts.flatMap((attempt) => [...(attempt.votesAgainst?.values() || [])]);
    return failures.length > 0 && failures.every((failure) => failure?.name === 'ResourceLockedError');
};

const _acquireInMemoryLock = async (key, ttlMs, retryCount = 15, delayMs = 150) => {
    const lockKey = `lock:${key}`;
    
    for (let attempt = 0; attempt < retryCount; attempt++) {
        if (!_inMemoryLocks.has(lockKey)) {
            const owner = Symbol(lockKey);
            _inMemoryLocks.set(lockKey, owner);
            
            // تحرير تلقائي بعد انتهاء الـ TTL لمنع بقاء القفل للأبد
            const timeoutId = setTimeout(() => {
                if (_inMemoryLocks.get(lockKey) === owner) _inMemoryLocks.delete(lockKey);
            }, ttlMs);
            if (typeof timeoutId.unref === 'function') timeoutId.unref();

            return {
                release: async () => {
                    clearTimeout(timeoutId);
                    if (_inMemoryLocks.get(lockKey) === owner) _inMemoryLocks.delete(lockKey);
                },
                __inMemory: true
            };
        }
        
        // الانتظار قبل المحاولة التالية
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    
    throw lockError('LOCK_BUSY', `LOCK_ACQUISITION_TIMEOUT: Failed to acquire lock for key: ${key}`, null, 2);
};

/**
 * حجز قفل فريد للمورد
 * @param {string} key - معرف المورد الفريد (مثلاً: idempotency key أو رقم الحساب)
 * @param {number} ttlMs - مدة بقاء القفل بالملي ثانية
 * @returns {Promise<Object>} كائن القفل المخصص لتحريره لاحقاً
 */
const acquireLock = async (key, ttlMs = 5000, options = {}) => {
    const retryCount = options.retryCount !== undefined ? options.retryCount : 15;
    const delayMs = options.retryDelay !== undefined ? options.retryDelay : 150;

    if (isRedis()) {
        try {
            const rl = _initRedlock();
            if (rl) {
                const lockKey = `locks:${key}`;
                const lock = await rl.acquire([lockKey], ttlMs, { retryCount, retryDelay: delayMs });
                return lock;
            }
            throw lockError('LOCK_UNAVAILABLE', 'REDIS_LOCK_FAILED: Distributed lock initialization failed');
        } catch (err) {
            if (await isContention(err)) {
                let remaining = 2000;
                try {
                    const ttl = await getRedisClient().pttl(`locks:${key}`);
                    if (Number.isFinite(ttl) && ttl > 0) remaining = ttl;
                } catch (_) { /* Never bypass an occupied lock when TTL inspection fails. */ }
                throw lockError('LOCK_BUSY', 'LOCK_ACQUISITION_TIMEOUT: Resource is locked', err, Math.max(1, Math.ceil(remaining / 1000)));
            }
            if (isRedisRequired() && !options.allowMemoryFallback) {
                logger.error('CRITICAL: Redlock acquisition failed in production!', { key, error: err.message });
                throw lockError('LOCK_UNAVAILABLE', 'REDIS_LOCK_FAILED: Failed to acquire distributed lock in production', err);
            }
            warnAboutMemoryFallback('Redlock acquisition failed, using in-memory locks', { key, error: err.message });
        }
    } else {
        if (isRedisRequired() && !options.allowMemoryFallback) {
            logger.error('CRITICAL: Redis is not configured but running in production!');
            throw lockError('LOCK_UNAVAILABLE', 'REDIS_NOT_CONFIGURED: Redis is mandatory in production mode');
        }
        warnAboutMemoryFallback('Redis is unavailable, using in-memory locks in this single-process deployment');
    }
    
    // Fallback لـ In-Memory
    return _acquireInMemoryLock(key, ttlMs, retryCount, delayMs);
};

/**
 * تحرير القفل المحجوز
 * @param {Object} lock - كائن القفل المرتجع من دالة acquireLock
 */
const releaseLock = async (lock) => {
    if (!lock) return;
    
    try {
        if (lock.release && typeof lock.release === 'function') {
            await lock.release();
        }
    } catch (err) {
        logger.error('Failed to release lock', { error: err.message });
    }
};

module.exports = {
    acquireLock,
    releaseLock
};
