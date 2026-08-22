import { Request, Response, NextFunction } from 'express';
import logger from '../../../utils/logger';
const accountMfaService = require('../../../services/accountMfaService');

export interface IAuthRequest extends Request {
    user?: {
        userId: string;
        accountType: string;
        tenantId?: string;
        sessionId?: string;
        telegramId?: string;
        executorBotId?: string;
    };
    tenant?: {
        _id: any;
        name: string;
        domain: string;
    };
}

export const mfaMiddleware = async (req: IAuthRequest, res: Response, next: NextFunction) => {
    try {
        if (!req.user || !req.user.userId) {
            return res.status(401).json({ success: false, code: 'UNAUTHORIZED', message: 'غير مصرح بالوصول' });
        }

        const user = await accountMfaService.loadAccount(req.user.accountType, req.user.userId, req.user.tenantId || null);
        if (!user) {
            return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: 'المستخدم غير موجود' });
        }

        // إذا لم يكن العميل قد فعّل الـ MFA، لا داعي للتحقق
        if (!user.mfaEnabled || user.mfaType === 'none') {
            return next();
        }

        const deviceId = accountMfaService.deviceIdFor(req);
        if (await accountMfaService.isDeviceTrusted({
            account: user,
            accountType: req.user.accountType,
            deviceId,
            sessionId: req.user.sessionId
        })) {
            (req as any).mfaVerified = true;
            return next();
        }

        const mfaToken = req.headers['x-mfa-token'] as string;
        if (!mfaToken) {
            return res.status(403).json({
                success: false,
                code: 'MFA_REQUIRED',
                mfaType: user.mfaType,
                message: 'مطلوب رمز التحقق الثنائي (MFA)'
            });
        }

        const isValid = await accountMfaService.verifyAccountToken(user, mfaToken);

        if (!isValid) {
            logger.warn(`MFA verification failed for user ${user._id} using ${user.mfaType}`);
            return res.status(403).json({ success: false, code: 'MFA_INVALID', message: 'رمز التحقق الثنائي غير صحيح أو انتهت صلاحيته' });
        }

        next();
    } catch (err: any) {
        logger.error('MFA middleware error', { error: err.message });
        return res.status(500).json({ success: false, code: 'SERVER_ERROR', message: 'حدث خطأ داخلي أثناء التحقق الثنائي' });
    }
};
