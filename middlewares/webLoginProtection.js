'use strict';
const rateLimit = require('../utils/requestRateLimit');

const createLoginLimiter = () =>
    rateLimit({
        windowMs: 60 * 1000,
        max: 10,
        message: 'تم تجاوز الحد الأقصى لمحاولات تسجيل الدخول. حاول بعد دقيقة.',
        standardHeaders: true,
        legacyHeaders: false,
        // Failed legacy login forms render status 200. Count every attempt instead
        // of treating all 2xx/3xx responses as successful authentication.
        skipSuccessfulRequests: false,
    });

const validateLoginInput = (req, res, next) => {
    const body = req.body || {};
    const fields = {
        username: 254,
        webUsername: 254,
        userName: 254,
        phone: 254,
        password: 1024,
        webPassword: 1024,
        userPassword: 1024,
        pass: 1024,
    };
    for (const [key, limit] of Object.entries(fields)) {
        if (body[key] === undefined) continue;
        if (typeof body[key] !== 'string' || body[key].length > limit || body[key].includes('\0')) {
            return res.status(400).send('بيانات تسجيل الدخول غير صالحة.');
        }
    }
    // MFA-only posts deliberately do not require a username or password here.
    return next();
};
module.exports = { createLoginLimiter, validateLoginInput };
