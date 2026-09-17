// middlewares/errorHandler.js
// 🚀 Production-Ready Error Handler with Enhanced Logging

const logger = require('../utils/logger');
const { formatApiResponse } = require('../utils/productionEnhancements');

const errorHandler = (err, req, res, next) => {
    // 🚀 تسجيل مفصل للأخطاء مع السياق الكامل
    logger.error('Global error caught', {
        error: err.message,
        stack: err.stack,
        name: err.name,
        code: err.code,
        url: req.originalUrl,
        method: req.method,
        userAgent: req.get('User-Agent'),
        ip: req.ip,
        timestamp: new Date().toISOString()
    });

    const statusCode = res.statusCode === 200 ? 500 : res.statusCode;
    
    // إذا كان الطلب من الموبايل أو الـ API
    if (req.xhr || req.originalUrl.startsWith('/api') || 
        req.originalUrl.startsWith('/client') || 
        req.originalUrl.startsWith('/executor-portal')) {
        
        return res.json(formatApiResponse(
            false,
            process.env.NODE_ENV === 'production' 
                ? 'حدث خطأ داخلي في الخادم، يرجى المحاولة لاحقاً.' 
                : err.message,
            'يرجى المحاولة لاحقاً',
            {
                code: err.code,
                name: err.name,
                path: req.originalUrl,
                method: req.method,
                timestamp: new Date().toISOString()
            }
        ));
    }

    // إذا كان الطلب من لوحة تحكم الويب
    res.status(statusCode).send(`
        <div style="text-align: center; padding: 50px; font-family: sans-serif; background-color: #f8fafc; height: 100vh;">
            <div style="background: white; padding: 40px; border-radius: 20px; box-shadow: 0 10px 25px rgba(0,0,0,0.05); max-width: 500px; margin: 0 auto;">
                <h1 style="color: #ef4444; font-size: 50px; margin-bottom: 10px;">⚠️</h1>
                <h2 style="color: #1e293b;">عذراً، حدث خطأ مفاجئ!</h2>
                <p style="color: #64748b; margin-bottom: 30px;">لقد تم تسجيل الخطأ في النظام وسيقوم الدعم الفني بمراجعته.</p>
                ${process.env.NODE_ENV !== 'production' ? `<p style="color:#94a3b8;font-size:12px;">${err.message}</p>` : ''}
                <a href="/" style="padding: 12px 25px; background: #3b82f6; color: white; text-decoration: none; border-radius: 10px; font-weight: bold;">العودة للرئيسية</a>
            </div>
        </div>
    `);
};

// معالج الصفحات غير الموجودة (404)
const notFoundHandler = (req, res, next) => {
    logger.warn('Page not found', {
        url: req.originalUrl,
        method: req.method,
        ip: req.ip,
        userAgent: req.get('User-Agent')
    });
    
    if (req.xhr || req.originalUrl.startsWith('/api') || 
        req.originalUrl.startsWith('/client') || 
        req.originalUrl.startsWith('/executor-portal')) {
        return res.status(404).json(formatApiResponse(false, 'الصفحة غير موجودة', 'Resource not found'));
    }
    
    res.status(404).send('الصفحة أو المسار غير موجود (404)');
};

module.exports = { errorHandler, notFoundHandler };