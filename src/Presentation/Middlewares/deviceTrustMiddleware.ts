import { Response, NextFunction } from 'express';
import { IAuthRequest } from './mfaMiddleware';
import logger from '../../../utils/logger';
const accountMfaService = require('../../../services/accountMfaService');
const { isSecurityVerificationRequired } = require('../../../config/securityPolicy');

const isTransferPath = (req: IAuthRequest) => {
    const routePath = String(req.originalUrl || `${req.baseUrl || ''}${req.path || ''}`).split('?')[0].toLowerCase();
    return routePath.includes('/new-transfer')
        || routePath.includes('/transfer')
        || routePath.includes('/balance-transfer');
};

export const deviceTrustMiddleware = async (req: IAuthRequest, res: Response, next: NextFunction) => {
    const markUntrusted = () => {
        (req as any).isDeviceTrusted = false;
    };

    try {
        if (!isSecurityVerificationRequired()) {
            (req as any).isDeviceTrusted = true;
            return next();
        }
        if (!req.user || !req.user.userId) {
            markUntrusted();
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

        (req as any).isDeviceTrusted = isTrusted;
        (req as any).deviceFingerprint = deviceId;

        if (!isTrusted) {
            logger.warn(`Device not trusted for user ${req.user.userId}`, { accountType: req.user.accountType });
        }

        next();
    } catch (err: any) {
        logger.error('Device trust middleware error', { error: err.message });
        markUntrusted();
        // Transfer paths fail closed: do not continue as if the device were trusted.
        if (isSecurityVerificationRequired() && isTransferPath(req)) {
            return res.status(503).json({
                success: false,
                code: 'DEVICE_TRUST_UNAVAILABLE',
                message: 'تعذر التحقق من موثوقية الجهاز. أعد المحاولة لاحقاً.'
            });
        }
        next();
    }
};
