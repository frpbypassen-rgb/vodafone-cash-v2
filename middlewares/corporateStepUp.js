'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const ClientEmployee = require('../models/ClientEmployee');
const SecurityDevice = require('../models/SecurityDevice');
const passkeyService = require('../services/passkeyService');

const STEP_UP_TTL_MS = 90 * 1000;

const timingEqual = (left, right) => {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    if (!a.length || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
};

const issueStepUpTicket = (req) => {
    if (!req.session) req.session = {};
    const token = crypto.randomBytes(32).toString('hex');
    req.session.corporateStepUp = {
        token,
        actorId: String(req.corporate.actor._id),
        expiresAt: Date.now() + STEP_UP_TTL_MS,
        used: false
    };
    return token;
};

const consumeStepUpTicket = (req) => {
    const ticket = req.session?.corporateStepUp;
    const presented = String(req.body?.stepUpToken || req.headers?.['x-corporate-step-up'] || '').trim();
    if (!ticket || !presented || ticket.used) return false;
    if (Number(ticket.expiresAt) <= Date.now()) return false;
    if (String(ticket.actorId) !== String(req.corporate?.actor?._id || '')) return false;
    if (!timingEqual(ticket.token, presented)) return false;
    ticket.used = true;
    return true;
};

const verifyPasswordProof = async (req) => {
    const password = String(req.body?.password || req.body?.confirmPassword || req.body?.pin || '').trim();
    if (password.length < 4) return false;
    const employee = await ClientEmployee.findById(req.corporate.actor._id);
    if (!employee?.webPassword) return false;
    return bcrypt.compare(password, employee.webPassword);
};

const verifyWebauthnProof = async (req) => {
    const assertion = req.body?.webauthn || req.body?.credential;
    const expectedChallenge = req.session?.corporateWebauthnChallenge;
    if (!assertion || !expectedChallenge) return false;
    const credentialId = assertion.id || assertion.rawId;
    const device = await SecurityDevice.findOne({
        principalType: 'client_company',
        principalId: String(req.corporate.actor._id),
        credentialId,
        status: 'active'
    });
    if (!device) return false;
    await passkeyService.verifyAuthentication({
        req,
        response: assertion,
        expectedChallenge,
        device
    });
    delete req.session.corporateWebauthnChallenge;
    return true;
};

const requireCorporateStepUp = async (req, res, next) => {
    if (String(req.body?.status || '').trim() === 'draft') return next();
    try {
        if (consumeStepUpTicket(req)) return next();
        if (await verifyPasswordProof(req)) return next();
        if (await verifyWebauthnProof(req)) return next();
        return res.status(403).json({
            success: false,
            code: 'STEP_UP_REQUIRED',
            error: 'أكد العملية بكلمة المرور أو مفتاح المرور على نفس الطلب.'
        });
    } catch (_error) {
        return res.status(403).json({
            success: false,
            code: 'STEP_UP_INVALID',
            error: 'فشل تأكيد الهوية للعملية الحساسة.'
        });
    }
};

module.exports = {
    STEP_UP_TTL_MS,
    issueStepUpTicket,
    consumeStepUpTicket,
    verifyPasswordProof,
    verifyWebauthnProof,
    requireCorporateStepUp
};
