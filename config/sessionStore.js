'use strict';

const DEFAULT_TOUCH_AFTER_SECONDS = 120;

const sessionTouchAfterSeconds = (env = process.env) => {
    const configured = Number(env.SESSION_TOUCH_AFTER_SECONDS);
    if (Number.isFinite(configured) && configured >= 30 && configured <= 3600) {
        return Math.floor(configured);
    }
    return DEFAULT_TOUCH_AFTER_SECONDS;
};

const mongoSessionStoreOptions = ({ mongoUrl, ttlSeconds, env = process.env } = {}) => ({
    mongoUrl,
    ttl: ttlSeconds,
    autoRemove: 'native',
    // rolling cookies still refresh in the browser; this stops connect-mongo
    // from rewriting the sessions collection on every authenticated request.
    touchAfter: sessionTouchAfterSeconds(env),
    mongoOptions: {
        retryWrites: false,
        serverSelectionTimeoutMS: 120000,
        connectTimeoutMS: 120000,
        socketTimeoutMS: 120000
    }
});

module.exports = {
    DEFAULT_TOUCH_AFTER_SECONDS,
    sessionTouchAfterSeconds,
    mongoSessionStoreOptions
};
