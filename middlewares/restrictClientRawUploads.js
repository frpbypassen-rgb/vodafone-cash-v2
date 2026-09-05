'use strict';

// Customer files must be delivered through portal proxy routes that verify
// ownership. This middleware sits before the generic static uploads handler.
module.exports = (req, res, next) => {
    if (req.session?.isClientLoggedIn) {
        return res.status(403).send('Forbidden');
    }
    return next();
};
