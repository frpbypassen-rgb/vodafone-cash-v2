'use strict';

const regenerateSession = (req) => new Promise((resolve, reject) => {
    if (!req.session || typeof req.session.regenerate !== 'function') {
        reject(new Error('Session regeneration is unavailable.'));
        return;
    }

    req.session.regenerate((error) => {
        if (error) reject(error);
        else resolve();
    });
});

const establishAuthenticatedSession = async (req, values) => {
    await regenerateSession(req);
    Object.assign(req.session, values);
};

module.exports = {
    establishAuthenticatedSession,
    regenerateSession
};
