'use strict';

const { extractDeviceInfo } = require('../services/securityService');

const requireIp = (req, res, next) => {
    // Exclude static resources, metrics, and health checks
    const path = req.path || '';
    if (
        path.startsWith('/health') ||
        path.startsWith('/metrics') ||
        path.includes('.') ||
        path.startsWith('/uploads') ||
        process.env.NODE_ENV === 'test'
    ) {
        return next();
    }

    const { ip } = extractDeviceInfo(req);

    if (!ip || ip === 'unknown') {
        const errorMsg = 'تم رفض العملية: لا يمكن تحديد عنوان IP الخاص بجهازك لأسباب أمنية.';
        if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
            return res.status(400).json({
                success: false,
                error: errorMsg
            });
        }
        return res.status(400).send(`
            <div style="font-family: 'Tajawal', sans-serif; text-align: center; margin-top: 100px; direction: rtl;">
                <h1 style="color: #ef4444;">خطأ أمني</h1>
                <p style="font-size: 1.2rem; color: #4b5563;">${errorMsg}</p>
            </div>
        `);
    }

    next();
};

module.exports = requireIp;
