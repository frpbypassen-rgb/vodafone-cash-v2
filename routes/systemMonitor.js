'use strict';

const express = require('express');
const path = require('path');
const systemMonitor = require('../services/systemMonitorService');

const router = express.Router();

function isLocalRequest(req) {
    if (process.env.ALLOW_PUBLIC_SYSTEM_MONITOR === 'true') return true;
    const host = String(req.headers.host || '').split(':')[0];
    const ip = String(req.ip || req.socket?.remoteAddress || '');
    return (
        host === 'localhost'
        || host === '127.0.0.1'
        || host === '::1'
        || ip === '127.0.0.1'
        || ip === '::1'
        || ip === '::ffff:127.0.0.1'
    );
}

function requireLocalMonitor(req, res, next) {
    if (isLocalRequest(req)) return next();
    return res.status(403).send('لوحة مراقبة التشغيل متاحة محلياً فقط.');
}

router.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    next();
});

router.get('/', requireLocalMonitor, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'system-monitor.html'));
});

router.get('/api/status', requireLocalMonitor, async (req, res) => {
    const snapshot = await systemMonitor.getSnapshot();
    res.json({
        status: 'ok',
        ...snapshot
    });
});

module.exports = router;
