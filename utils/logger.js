// utils/logger.js
// ===============================================
// 📊 Winston Structured Logger
// ===============================================

const { createLogger, format, transports } = require('winston');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'logs');

const logger = createLogger({
    level: process.env.LOG_LEVEL || 'info',
    format: format.combine(
        format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        format.errors({ stack: true }),
        format.json()
    ),
    defaultMeta: { service: 'ahram-pay' },
    transports: [
        // Console output (colorized for dev)
        new transports.Console({
            format: format.combine(
                format.colorize(),
                format.printf(({ timestamp, level, message, service, ...meta }) => {
                    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
                    return `${timestamp} [${service}] ${level}: ${message}${metaStr}`;
                })
            )
        }),
        // Error log file
        new transports.File({
            filename: path.join(LOG_DIR, 'error.log'),
            level: 'error',
            maxsize: 10 * 1024 * 1024,  // 10MB
            maxFiles: 5,
            tailable: true
        }),
        // Combined log file
        new transports.File({
            filename: path.join(LOG_DIR, 'combined.log'),
            maxsize: 10 * 1024 * 1024,  // 10MB
            maxFiles: 10,
            tailable: true
        })
    ]
});

// Convenience methods for financial operations
logger.financial = (action, data) => {
    logger.info(`💰 ${action}`, { category: 'financial', ...data });
};

logger.security = (action, data) => {
    logger.warn(`🔒 ${action}`, { category: 'security', ...data });
};

logger.audit = (action, data) => {
    logger.info(`📋 ${action}`, { category: 'audit', ...data });
};

module.exports = logger;
