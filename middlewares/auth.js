// middlewares/auth.js

const requireAuth = (req, res, next) => {
    if (req.session.isLoggedIn) {
        return next();
    }
    // 🟢 منع توجيه طلبات الـ API والموبايل لصفحات الـ HTML وإرجاع خطأ نظيف
    if (req.xhr || (req.headers && req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.status(401).json({ success: false, error: 'غير مصرح بالوصول، يرجى تسجيل الدخول.' });
    }
    res.redirect('/login');
};

const requireMaster = (req, res, next) => {
    if (req.session.isLoggedIn && req.session.role === 'master') {
        return next();
    }
    res.redirect('/'); 
};

module.exports = { requireAuth, requireMaster };