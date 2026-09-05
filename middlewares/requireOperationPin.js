'use strict';

const operationPinService = require('../services/operationPinService');
const securityControl = require('../services/securityControlService');

module.exports = async (req, res, next) => {
    try {
        // Route contract tests intentionally do not provision operation-PIN
        // records. Production never takes this branch.
        if (process.env.NODE_ENV === 'test' && process.env.OPERATION_PIN_TEST_ENFORCEMENT !== 'true') {
            return next();
        }
        const principal = req.user?.userId
            ? operationPinService.principalFromUser(req.user)
            : securityControl.sessionPrincipal(req.session);
        if (!principal) return res.status(401).json({ success: false, code: 'UNAUTHORIZED', error: 'انتهت جلسة الدخول.' });
        await operationPinService.verifyForTransfer({
            principal,
            pin: req.body?.operationPin || req.headers['x-operation-pin']
        });
        return next();
    } catch (error) {
        const code = error.code || 'OPERATION_PIN_INVALID';
        const message = code === 'OPERATION_PIN_LOCKED'
            ? 'تم إيقاف رمز العمليات مؤقتاً بسبب محاولات غير صحيحة.'
            : 'أدخل رمز العمليات الصحيح لإتمام التحويل.';
        return res.status(code === 'OPERATION_PIN_LOCKED' ? 423 : 403).json({ success: false, code, error: message });
    }
};
