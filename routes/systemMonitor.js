'use strict';

const express = require('express');
const path = require('path');
const systemMonitor = require('../services/systemMonitorService');
const { requireOperationalAccess } = require('../middlewares/operationalAccess');

const router = express.Router();

const requireMonitorAccess = requireOperationalAccess({
    tokenEnv: 'SYSTEM_MONITOR_AUTH_TOKEN',
    deniedMessage: 'لوحة مراقبة التشغيل متاحة محلياً أو برمز تشغيل مصرح به فقط.'
});

router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

router.get('/', requireMonitorAccess, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'system-monitor.html'));
});

router.get('/api/status', requireMonitorAccess, async (req, res) => {
    const snapshot = await systemMonitor.getSnapshot();
    res.json({
        status: 'ok',
        ...snapshot
    });
});

module.exports = router;
