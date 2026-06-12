// services/lockService.js
// ===============================================
// 🔒 خدمة قفل التوزيع — Distributed Lock Service
// ===============================================
'use strict';

const { getRedisClient, isRedis } = require('../config/redis');
const logger = require('../utils/logger');

let redlock = null;

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

        redlock.on('clientError', (err) => {
            logger.error('Redlock client error', { error: err.message });
        });

        logger.info('✅ Redlock initialized successfully');
        return redlock;
    } catch (e) {
        logger.warn('⚠️ Failed to initialize Redlock, falling back to In-Memory locks', { error: e.message });
        return null;
    }
};

// ── In-Memory Lock Fallback (للبيئات المحلية بدون Redis) ──────
const _inMemoryLocks = new Set();

const _acquireInMemoryLock = async (key, ttlMs, retryCount = 15, delayMs = 150) => {
    const lockKey = `lock:${key}`;
    
    for (let attempt = 0; attempt < retryCount; attempt++) {
        if (!_inMemoryLocks.has(lockKey)) {
            _inMemoryLocks.add(lockKey);
            
            // تحرير تلقائي بعد انتهاء الـ TTL لمنع بقاء القفل للأبد
            const timeoutId = setTimeout(() => {
                _inMemoryLocks.delete(lockKey);
            }, ttlMs);
            if (typeof timeoutId.unref === 'function') timeoutId.unref();

            return {
                release: async () => {
                    clearTimeout(timeoutId);
                    _inMemoryLocks.delete(lockKey);
                },
                __inMemory: true
            };
        }
        
        // الانتظار قبل المحاولة التالية
        await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    
    throw new Error(`LOCK_ACQUISITION_TIMEOUT: Failed to acquire lock for key: ${key}`);
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
                const lock = await rl.acquire([lockKey], ttlMs);
                return lock;
            }
        } catch (err) {
            if (process.env.NODE_ENV === 'production') {
                logger.error('CRITICAL: Redlock acquisition failed in production!', { key, error: err.message });
                throw new Error('REDIS_LOCK_FAILED: Failed to acquire distributed lock in production');
            }
            logger.warn('Redlock acquisition failed, falling back to In-Memory lock', { key, error: err.message });
        }
    } else {
        if (process.env.NODE_ENV === 'production') {
            logger.error('CRITICAL: Redis is not configured but running in production!');
            throw new Error('REDIS_NOT_CONFIGURED: Redis is mandatory in production mode');
        }
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
