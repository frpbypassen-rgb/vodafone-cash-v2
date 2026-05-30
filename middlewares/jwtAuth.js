const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'ahram-mobile-super-secret-key-2026';
const JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'ahram-refresh-super-secret';

const authenticateJWT = (req, res, next) => {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.split(' ')[1];

        jwt.verify(token, JWT_SECRET, (err, decodedUser) => {
            if (err) {
                // رسالة واضحة للموبايل ليقوم بتجديد التوكن
                return res.status(401).json({ 
                    success: false, 
                    code: 'TOKEN_EXPIRED', 
                    message: 'جلستك الحالية انتهت، يرجى تحديث التوكن (Refresh Token)' 
                });
            }
            req.user = decodedUser; 
            next();
        });
    } else {
        res.status(401).json({ 
            success: false, 
            code: 'UNAUTHORIZED', 
            message: 'غير مصرح بالوصول، التوكن مفقود' 
        });
    }
};

module.exports = { authenticateJWT, JWT_SECRET, JWT_REFRESH_SECRET };