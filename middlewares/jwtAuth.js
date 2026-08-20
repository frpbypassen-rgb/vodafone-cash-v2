const jwt = require('jsonwebtoken');

// 🛡️ حماية قصوى: لا يُسمح بتشغيل السيرفر بدون مفاتيح سرية حقيقية
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error('🚨 [FATAL] JWT_SECRET غير موجود أو قصير جداً (أقل من 32 حرف). يُرجى ضبطه في ملف .env');
    process.exit(1);
}
if (!process.env.JWT_REFRESH_SECRET || process.env.JWT_REFRESH_SECRET.length < 32) {
    console.error('🚨 [FATAL] JWT_REFRESH_SECRET غير موجود أو قصير جداً (أقل من 32 حرف). يُرجى ضبطه في ملف .env');
    process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

const cleanId = (value) => value === undefined || value === null ? '' : String(value).trim();
const allowsLegacyTenantTokens = () => (
    process.env.NODE_ENV !== 'production'
    && String(process.env.ALLOW_LEGACY_TENANT_TOKENS || 'true').toLowerCase() === 'true'
);
const tokenMatchesRequestTenant = (decodedUser, req) => {
    const requestTenantId = cleanId(req && req.tenant && req.tenant._id);
    const tokenTenantId = cleanId(decodedUser && decodedUser.tenantId);

    if (!requestTenantId) return process.env.NODE_ENV !== 'production';
    if (!tokenTenantId) return allowsLegacyTenantTokens();
    return requestTenantId === tokenTenantId;
};

const ensureActiveExecutor = async (decodedUser) => {
    if (!decodedUser || decodedUser.accountType !== 'executor') return true;

    const Employee = require('../models/Employee');
    const employee = await Employee.findById(decodedUser.userId)
        .select('status groupId')
        .populate('groupId', 'status');
    return Boolean(
        employee
        && employee.status === 'active'
        && employee.groupId
        && employee.groupId.status === 'active'
    );
};

const ensureActiveCustomerSession = async (decodedUser) => {
    if (!decodedUser || !['client_user', 'sub_client'].includes(decodedUser.accountType)) return true;

    const Model = decodedUser.accountType === 'sub_client'
        ? require('../models/SubAccount')
        : require('../models/User');
    const account = await Model.findById(decodedUser.userId).select('status sessionVersion');
    const accountIsActive = Boolean(
        account
        && account.status === 'active'
        && Number(account.sessionVersion || 0) === Number(decodedUser.sessionVersion || 0)
    );
    if (!accountIsActive || !decodedUser.sessionId) return accountIsActive;

    const MobileDeviceSession = require('../models/MobileDeviceSession');
    const session = await MobileDeviceSession.exists({
        accountId: decodedUser.userId,
        accountType: decodedUser.accountType,
        ...(decodedUser.tenantId ? { tenantId: decodedUser.tenantId } : {}),
        sessionId: decodedUser.sessionId,
        active: true
    });
    return Boolean(session);
};

const authenticateJWT = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];

        jwt.verify(token, JWT_SECRET, async (err, decodedUser) => {
            if (err) {
                const code = err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID';
                const message = code === 'TOKEN_EXPIRED'
                    ? 'جلستك الحالية انتهت، يرجى تحديث التوكن (Refresh Token)'
                    : 'التوكن غير صالح';
                return res.status(401).json({
                    success: false,
                    code,
                    message,
                    correlationId: req.correlationId || null
                });
            }
            try {
                if (!tokenMatchesRequestTenant(decodedUser, req)) {
                    return res.status(403).json({
                        success: false,
                        code: 'TENANT_ACCESS_DENIED',
                        message: 'رمز الدخول لا يخص هذه المنظمة',
                        correlationId: req.correlationId || null
                    });
                }
                if (!await ensureActiveExecutor(decodedUser) || !await ensureActiveCustomerSession(decodedUser)) {
                    return res.status(401).json({
                        success: false,
                        code: 'ACCOUNT_INACTIVE',
                        message: 'حساب المنفذ موقوف أو مؤرشف',
                        correlationId: req.correlationId || null
                    });
                }
                req.user = decodedUser;
                next();
            } catch (_) {
                return res.status(401).json({
                    success: false,
                    code: 'ACCOUNT_INACTIVE',
                    message: 'تعذر التحقق من حالة حساب المنفذ',
                    correlationId: req.correlationId || null
                });
            }
        });
    } else {
        res.status(401).json({
            success: false,
            code: 'TOKEN_INVALID',
            message: 'غير مصرح بالوصول، التوكن مفقود',
            correlationId: req.correlationId || null
        });
    }
};

module.exports = {
    authenticateJWT,
    ensureActiveExecutor,
    ensureActiveCustomerSession,
    tokenMatchesRequestTenant,
    JWT_SECRET,
    JWT_REFRESH_SECRET
};
