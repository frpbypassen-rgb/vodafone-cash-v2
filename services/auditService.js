const crypto = require('crypto');
const AuditLog = require('../models/AuditLog');
const { acquireLock, releaseLock } = require('./lockService');

const calculateHash = (entry, previousHash) => {
    const data = {
        action: entry.action,
        performedBy: entry.performedBy ? entry.performedBy.toString() : null,
        performedByModel: entry.performedByModel,
        performedByName: entry.performedByName,
        targetId: entry.targetId ? entry.targetId.toString() : null,
        targetModel: entry.targetModel,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
        endpoint: entry.endpoint,
        oldData: entry.oldData,
        newData: entry.newData,
        metadata: entry.metadata,
        success: entry.success,
        errorCode: entry.errorCode,
        result: entry.result,
        initiator: entry.initiator,
        deviceType: entry.deviceType,
        location: entry.location,
        previousHash: previousHash
    };
    return crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
};

/**
 * تسجيل عملية في سجل التدقيق
 *
 * @param {Object} params
 * @param {string}  params.action           - نوع العملية (من enum AuditLog.action)
 * @param {Object}  params.req              - كائن الطلب Express (لاستخراج IP و UserAgent)
 * @param {string}  [params.performedById]  - معرّف من قام بالعملية
 * @param {string}  [params.performedByModel] - نوع الكيان (Employee / ClientEmployee / User / Admin)
 * @param {string}  [params.performedByName]  - اسم من قام بالعملية
 * @param {string}  [params.targetId]       - معرّف الجهة المستهدفة
 * @param {string}  [params.targetModel]    - نوع الكيان المستهدف
 * @param {Object}  [params.oldData]        - البيانات قبل التغيير
 * @param {Object}  [params.newData]        - البيانات بعد التغيير
 * @param {Object}  [params.metadata]       - بيانات إضافية
 * @param {boolean} [params.success=true]   - هل نجحت العملية؟
 * @param {string}  [params.errorCode]      - كود الخطأ في حالة الفشل
 * @returns {Promise<void>}
 */
const logAction = async (params) => {
    let auditLock;
    try {
        const {
            action,
            req,
            performedById,
            performedByModel,
            performedByName,
            targetId,
            targetModel,
            oldData,
            newData,
            metadata,
            success = true,
            errorCode,
            result,
            initiator,
            deviceType,
            location
        } = params;

        const ipAddress = req
            ? (req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.headers['x-real-ip'] || req.ip || 'unknown')
            : 'system';

        const userAgent = req ? req.headers['user-agent'] : 'system';
        const endpoint = req ? `${req.method} ${req.originalUrl}` : null;

        // Parse initiator & deviceType
        let finalInitiator = initiator;
        let finalDeviceType = deviceType;

        if (!finalInitiator || !finalDeviceType) {
            const userAgentStr = userAgent || '';
            if (!finalInitiator) {
                const isApp = req && (
                    req.originalUrl?.includes('/api/mobile') ||
                    req.originalUrl?.includes('/api/v1/mobile') ||
                    req.headers?.['x-client-platform'] === 'app' ||
                    /dart|flutter|okhttp|retrofit|alamofire|postman/i.test(userAgentStr)
                );
                finalInitiator = isApp ? 'تطبيق' : 'موقع';
            }
            if (!finalDeviceType) {
                const isMobile = /mobile|android|iphone|ipad|phone/i.test(userAgentStr);
                finalDeviceType = isMobile ? 'هاتف' : 'كمبيوتر';
            }
        }

        // Parse result
        let finalResult = result;
        if (!finalResult) {
            if (success) {
                if (action === 'TRANSFER_CREATED' || action.includes('PENDING')) {
                    finalResult = 'معلق';
                } else {
                    finalResult = 'ناجح';
                }
            } else {
                if (['ACCOUNT_BANNED', 'ACCOUNT_LOCKED', 'SUSPENDED', 'BANNED', 'BLOCKED', 'INVALID_OTP'].includes(errorCode)) {
                    finalResult = 'محظور';
                } else {
                    finalResult = 'فاشل';
                }
            }
        }

        // Parse location
        let finalLocation = location;
        if (!finalLocation && req) {
            const latitude = req.body?.latitude || req.headers?.['x-client-latitude'] || req.query?.latitude;
            const longitude = req.body?.longitude || req.headers?.['x-client-longitude'] || req.query?.longitude;
            if (latitude && longitude && !isNaN(Number(latitude)) && !isNaN(Number(longitude))) {
                finalLocation = {
                    latitude: Number(latitude),
                    longitude: Number(longitude)
                };
            }
        }

        auditLock = await acquireLock('audit-log-chain', 10000, { retryCount: 20, retryDelay: 100 });

        // حساب تشفير السلسلة المترابطة (Hash Chained Audit Trail)
        const lastEntry = await AuditLog.findOne().sort({ _id: -1 }).select('hash').lean();
        const previousHash = lastEntry ? lastEntry.hash : 'GENESIS';

        const entryData = {
            action,
            performedBy: performedById || null,
            performedByModel: performedByModel || 'System',
            performedByName: performedByName || 'System',
            targetId: targetId || null,
            targetModel: targetModel || null,
            ipAddress,
            userAgent,
            endpoint,
            oldData: oldData ? sanitizeData(oldData) : undefined,
            newData: newData ? sanitizeData(newData) : undefined,
            metadata,
            success,
            errorCode,
            result: finalResult,
            initiator: finalInitiator,
            deviceType: finalDeviceType,
            location: finalLocation,
            previousHash
        };
        entryData.hash = calculateHash(entryData, previousHash);

        const entry = new AuditLog(entryData);
        await entry.save();
    } catch (err) {
        // لا نرمي الخطأ — فشل التسجيل لا يجب أن يوقف العملية الأصلية
        console.error('⚠️ [AuditService] فشل في تسجيل التدقيق:', err.message);
    } finally {
        await releaseLock(auditLock);
    }
};

/**
 * إزالة الحقول الحساسة من البيانات قبل تسجيلها
 */
const sanitizeData = (data) => {
    if (!data || typeof data !== 'object') return data;
    const sensitiveFields = ['password', 'webPassword', 'refreshToken', 'token', 'secret'];
    const cleaned = { ...data };
    for (const field of sensitiveFields) {
        if (cleaned[field] !== undefined) {
            cleaned[field] = '[REDACTED]';
        }
    }
    return cleaned;
};

/**
 * استرجاع سجل التدقيق لجهة معينة
 * @param {string} entityId - معرّف الجهة
 * @param {Object} [options]
 * @param {number} [options.limit=50]
 * @param {number} [options.skip=0]
 * @param {string} [options.action] - فلتر نوع العملية
 */
const getAuditLogs = async (entityId, options = {}) => {
    const { limit = 50, skip = 0, action } = options;
    const filter = {
        $or: [{ performedBy: entityId }, { targetId: entityId }]
    };
    if (action) filter.action = action;

    return AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean();
};

module.exports = { logAction, getAuditLogs, calculateHash };
