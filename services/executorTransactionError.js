'use strict';

const logger = require('../utils/logger');

class ExecutorTransactionError extends Error {
    constructor(message, statusCode = 400, code) {
        super(message);
        this.name = 'ExecutorTransactionError';
        this.statusCode = statusCode;
        if (code) this.code = code;
    }
}

const logExecutorFailure = (operation, error) => {
    // Provider errors may contain credentials in URLs or request metadata.
    logger.error(`Executor ${operation} failed`, {
        errorType: error?.constructor?.name || 'Error',
        databaseCode: typeof error?.code === 'number' ? error.code : undefined
    });
};

module.exports = { ExecutorTransactionError, logExecutorFailure };
