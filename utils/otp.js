'use strict';

const crypto = require('crypto');

const OTP_DIGITS = 6;

const getOtpSecret = () => (
    process.env.OTP_SECRET ||
    process.env.SESSION_SECRET ||
    process.env.JWT_SECRET ||
    'dev-otp-secret-change-me'
);

const generateOtp = () => crypto.randomInt(10 ** (OTP_DIGITS - 1), 10 ** OTP_DIGITS).toString();

const hashOtp = (otp) => crypto
    .createHmac('sha256', getOtpSecret())
    .update(String(otp || '').trim())
    .digest('hex');

const safeEqual = (left, right) => {
    const leftBuffer = Buffer.from(String(left || ''));
    const rightBuffer = Buffer.from(String(right || ''));
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
};

const verifyOtp = (submittedOtp, storedOtp) => {
    const submitted = String(submittedOtp || '').trim();
    const stored = String(storedOtp || '');
    if (!/^\d{6}$/.test(submitted) || !/^[a-f0-9]{64}$/i.test(stored)) return false;

    const submittedHash = hashOtp(submitted);
    return safeEqual(submittedHash, stored);
};

module.exports = {
    generateOtp,
    hashOtp,
    verifyOtp
};
