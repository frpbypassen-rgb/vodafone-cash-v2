import { Response, NextFunction } from 'express';
import { IAuthRequest } from './mfaMiddleware';
import logger from '../../../utils/logger';
const accountMfaService = require('../../../services/accountMfaService');

export const deviceTrustMiddleware = async (req: IAuthRequest, res: Response, next: NextFunction) => {
    try {
        if (!req.user || !req.user.userId) {
            return next();
        }

        const account = await accountMfaService.loadAccount(req.user.accountType, req.user.userId, req.user.tenantId || null);
        const deviceId = accountMfaService.deviceIdFor(req);
        const isTrusted = Boolean(account) && await accountMfaService.isDeviceTrusted({
            account,
            accountType: req.user.accountType,
            deviceId,
            sessionId: req.user.sessionId
        });

        // إرفاق حالة موثوقية الجهاز مع كائن الطلب لاستخدامها في محرك كشف الاحتيال
        (req as any).isDeviceTrusted = isTrusted;
        (req as any).deviceFingerprint = deviceId;

        if (!isTrusted) {
            logger.warn(`Device not trusted for user ${req.user.userId}`, { accountType: req.user.accountType });
        }

        next();
    } catch (err: any) {
        logger.error('Device trust middleware error', { error: err.message });
        next();
    }
};
