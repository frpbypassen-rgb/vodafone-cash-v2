import { Response, NextFunction } from 'express';
import { deviceTrustEngine, IDeviceSignature } from '../../Application/Services/DeviceTrustEngine';
import { IAuthRequest } from './mfaMiddleware';
import logger from '../../../utils/logger';

export const deviceTrustMiddleware = async (req: IAuthRequest, res: Response, next: NextFunction) => {
    try {
        if (!req.user || !req.user.userId) {
            return next();
        }

        const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() || req.ip || 'unknown';
        const userAgent = req.headers['user-agent'] || 'unknown';
        const fingerprintHeader = req.headers['x-device-fingerprint'] as string;

        const sig: IDeviceSignature = {
            ip,
            userAgent,
            fingerprint: fingerprintHeader
        };

        const isTrusted = deviceTrustEngine.isDeviceTrusted(req.user.userId, sig);

        // إرفاق حالة موثوقية الجهاز مع كائن الطلب لاستخدامها في محرك كشف الاحتيال
        (req as any).isDeviceTrusted = isTrusted;
        (req as any).deviceFingerprint = deviceTrustEngine.calculateFingerprint(sig);

        if (!isTrusted) {
            logger.warn(`Device not trusted for user ${req.user.userId}. Request details: IP: ${ip}, UA: ${userAgent}`);
        }

        next();
    } catch (err: any) {
        logger.error('Device trust middleware error', { error: err.message });
        next(); // لا نعطل العميل في حال حدوث خطأ داخلي في محرك التحقق من الجهاز
    }
};
