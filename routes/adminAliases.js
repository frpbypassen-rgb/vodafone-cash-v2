'use strict';

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middlewares/auth');

const ALIASES = Object.freeze({
    '/admin/settings': '/settings',
    '/admin/users': '/settings/users',
    '/admin/reports': '/reports',
    '/admin/dashboard': '/',
    '/admin/transactions': '/transactions',
    '/admin/live': '/transactions/live'
});

router.use(requireAuth);
Object.entries(ALIASES).forEach(([from, to]) => {
    router.get(from, (_req, res) => res.redirect(302, to));
});

module.exports = router;
module.exports.ALIASES = ALIASES;
