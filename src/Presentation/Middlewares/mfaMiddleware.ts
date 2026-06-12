import { Request, Response, NextFunction } from 'express';
import { mfaService } from '../../Application/Services/MfaService';
import User from '../../Domain/Entities/User';
import logger from '../../../utils/logger';
const ClientEmployee = require('../../../models/ClientEmployee');

export interface IAuthRequest extends Request {
    user?: {
        userId: string;
        accountType: string;
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

        const Model = req.user.accountType === 'client_company' ? ClientEmployee : User;
        const user = await Model.findById(req.user.userId);
        if (!user) {
            return res.status(404).json({ success: false, code: 'USER_NOT_FOUND', message: 'المستخدم غير موجود' });
        }

        // إذا لم يكن العميل قد فعّل الـ MFA، لا داعي للتحقق
        if (!user.mfaEnabled || user.mfaType === 'none') {
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

        let isValid = false;

        if (user.mfaType === 'totp' && user.totpSecret) {
            isValid = mfaService.verifyTotp(user.totpSecret, mfaToken);
        } else if ((user.mfaType === 'sms' || user.mfaType === 'email') && user.otpCode && user.otpExpires) {
            if (user.otpCode === mfaToken && user.otpExpires.getTime() > Date.now()) {
                isValid = true;
                // استهلاك الكود لمنع استخدامه مرة أخرى
                user.otpCode = undefined;
                user.otpExpires = undefined;
                await user.save();
            }
        }

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
