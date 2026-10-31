'use strict';
// Helmet does not implement Permissions-Policy. Limit access to this origin;
// proof capture, executor voice attachments and login geolocation still work.
module.exports = (_req, res, next) => {
    res.set('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(self)');
    next();
};
