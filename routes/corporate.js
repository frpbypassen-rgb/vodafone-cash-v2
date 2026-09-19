'use strict';

const express = require('express');
const router = express.Router();
const {
    requireCorporateAuth,
    requireSameCompany,
    allowCorporateCamera,
    detectCorporateView
} = require('../middlewares/corporateAuth');
const controller = require('../controllers/corporatePortalController');

router.use(allowCorporateCamera);
router.get('/sw.js', controller.serviceWorker);

router.use(requireCorporateAuth, requireSameCompany);

router.get('/', controller.renderPortal);
router.get('/transfers', (req, res, next) => {
    req.params.tab = 'transfers';
    return controller.renderPortal(req, res, next);
});
router.get('/approvals', (req, res, next) => {
    req.params.tab = 'approvals';
    return controller.renderPortal(req, res, next);
});
router.get('/reports', (req, res, next) => {
    req.params.tab = 'reports';
    return controller.renderPortal(req, res, next);
});
router.get('/team', (req, res, next) => {
    req.params.tab = 'team';
    return controller.renderPortal(req, res, next);
});
router.get('/beneficiaries', (req, res, next) => {
    req.params.tab = 'beneficiaries';
    return controller.renderPortal(req, res, next);
});

router.__test = { detectCorporateView };

module.exports = router;
