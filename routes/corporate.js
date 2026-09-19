'use strict';

const express = require('express');
const router = express.Router();

// Bookmarks and old PR#5 /corporate URLs land on the canonical company portal.
router.use((_req, res) => {
    res.redirect(302, '/client/services');
});

module.exports = router;
