'use strict';

const isStrongAdminPassword = (password) => (
    typeof password === 'string'
    && password.length >= 12
    && /[a-z]/.test(password)
    && /[A-Z]/.test(password)
    && /\d/.test(password)
    && /[^\w]/.test(password)
);

module.exports = { isStrongAdminPassword };
