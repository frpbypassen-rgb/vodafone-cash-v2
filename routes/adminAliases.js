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
    '/admin/live': '/transactions/live',
    '/admin/clients': '/clients',
    '/admin/companies': '/clients?section=companies',
    '/admin/agents': '/clients?section=agents'
});

const redirectWithQuery = (target, req, res) => {
    const queryIndex = String(req.originalUrl || req.url || '').indexOf('?');
    const query = queryIndex >= 0 && !target.includes('?')
        ? String(req.originalUrl || req.url).slice(queryIndex)
        : '';
    return res.redirect(302, `${target}${query}`);
};

router.use(requireAuth);
Object.entries(ALIASES).forEach(([from, to]) => {
    router.get(from, (req, res) => redirectWithQuery(to, req, res));
});

router.get('/admin/company/:id', (req, res) => {
    return redirectWithQuery(`/company/${encodeURIComponent(req.params.id)}`, req, res);
});

router.get('/admin/user/:id', (req, res) => {
    return redirectWithQuery(`/user/${encodeURIComponent(req.params.id)}`, req, res);
});

module.exports = router;
module.exports.ALIASES = ALIASES;
