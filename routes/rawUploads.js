'use strict';

const express = require('express');
const { requireAuth, requireMaster } = require('../middlewares/auth');
const restrictClientRawUploads = require('../middlewares/restrictClientRawUploads');
const restrictExecutorRawUploads = require('../middlewares/restrictExecutorRawUploads');

module.exports = ({ uploadDir }) => {
    const router = express.Router();
    const staticOptions = {
        dotfiles: 'deny', index: false,
        setHeaders: (res) => res.setHeader('Cache-Control', 'private, no-store')
    };
    router.use(restrictClientRawUploads);
    router.use('/account-documents', requireAuth, requireMaster, express.static(uploadDir, staticOptions));
    router.use(restrictExecutorRawUploads, express.static(uploadDir, staticOptions));
    return router;
};
