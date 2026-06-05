// middlewares/auth.js

/**
 * التحقق من تسجيل الدخول — يُستخدم لحماية جميع صفحات لوحة التحكم
 */
const requireAuth = (req, res, next) => {
    if (req.session.isLoggedIn) {
        return next();
    }
    // منع توجيه طلبات الـ API لصفحات HTML وإرجاع خطأ نظيف
    if (req.xhr || (req.headers && req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(401).json({ success: false, error: 'غير مصرح بالوصول، يرجى تسجيل الدخول.' });
    }
    res.redirect('/login');
};

/**
 * Alias لـ requireAuth — للتوافق مع الكود الموجود في routes/index.js
 */
const isAuthenticated = requireAuth;

/**
 * التحقق من صلاحية Master فقط — إصلاح: يتحقق من adminRole (وليس role)
 */
const requireMaster = (req, res, next) => {
    if (req.session.isLoggedIn && req.session.adminRole === 'master') {
        return next();
    }
    // إذا كان طلب API أو JSON
    if (req.xhr || (req.headers && req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(403).json({ success: false, error: 'هذه العملية تتطلب صلاحيات المدير الأساسي.' });
    }
    res.redirect('/');
};

/**
 * التحقق من دور محدد — للمرونة في التحكم بالصلاحيات
 * @param {string[]} roles - مصفوفة الأدوار المسموح لها (مثال: ['master', 'admin'])
 */
const requireRole = (roles = []) => {
    return (req, res, next) => {
        if (req.session.isLoggedIn && roles.includes(req.session.adminRole)) {
            return next();
        }
        if (req.xhr || (req.headers && req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.status(403).json({ success: false, error: 'ليس لديك صلاحية للوصول لهذه العملية.' });
        }
        res.redirect('/');
    };
};

module.exports = { requireAuth, isAuthenticated, requireMaster, requireRole };