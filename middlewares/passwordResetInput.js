'use strict';

// Validate before string operations or service/database work. Query operators,
// arrays and nested objects are never accepted as reset credentials.
module.exports = (fields) => (req, res, next) => {
    // An empty POST has no parsed body. Let the route's required-field checks
    // handle it as a client error instead of dereferencing undefined.
    if (req.body == null) req.body = {};
    for (const field of fields) {
        const value = req.body?.[field];
        if (value !== undefined && (typeof value !== 'string' || value.includes('\0'))) {
            return res.status(400).json({
                success: false,
                code: 'PASSWORD_RESET_INPUT_INVALID',
                error: 'بيانات استعادة كلمة المرور غير صالحة.'
            });
        }
    }
    return next();
};
