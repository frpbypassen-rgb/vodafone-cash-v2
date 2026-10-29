'use strict';
const path = require('node:path');
const assets = new Set(['login-location.js', 'authenticator-login.js', 'business-login-otp.js',
    'auth-verification-control-room.js', 'business-login-otp.css']);
module.exports = (res, file) => {
    if (assets.has(path.basename(file))) res.setHeader('Cache-Control', 'no-store');
};
