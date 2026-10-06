'use strict';

const EXECUTOR_PASSWORD_MIN_LENGTH = 8;
const EXECUTOR_PASSWORD_MAX_LENGTH = 128;
const EXECUTOR_PASSWORD_MESSAGE = `كلمة المرور يجب ألا تقل عن ${EXECUTOR_PASSWORD_MIN_LENGTH} أحرف.`;

const isValidNewExecutorPassword = (value) => {
    const password = String(value || '');
    return password.length >= EXECUTOR_PASSWORD_MIN_LENGTH
        && password.length <= EXECUTOR_PASSWORD_MAX_LENGTH;
};

module.exports = {
    EXECUTOR_PASSWORD_MAX_LENGTH,
    EXECUTOR_PASSWORD_MESSAGE,
    EXECUTOR_PASSWORD_MIN_LENGTH,
    isValidNewExecutorPassword
};
