// controllers/auth/authController.js
// ===============================================
// 🔐 Controller — المصادقة (طبقة رقيقة)
// ===============================================
'use strict';

const authService = require('../../services/authService');
const { sendMobileError } = require('../../mappers/mobileErrorMapper');
const { toLoginResponse, toRefreshResponse, toLogoutResponse } = require('../../mappers/mobileAuthMapper');
const { validationResult } = require('express-validator');
const logger = require('../../utils/logger');
const eventBus = require('../../services/eventBus');

/**
 * POST /login
 */
const login = async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return sendMobileError(res, 400, 'VALIDATION_ERROR', errors.array()[0].msg, req.correlationId);
        }

        const { username, password } = req.body;
        const result = await authService.login(username, password, req);

        if (!result.success) {
            return sendMobileError(res, result.statusCode, result.code, result.message, req.correlationId);
        }

        const mappedResponse = toLoginResponse(result);
        if (result.accountType === 'executor' && result.id) {
            try {
                eventBus.publish('executor:security-alert', {
                    employeeId: String(result.id),
                    deviceName: String(req.get('user-agent') || 'تطبيق Ahram Pay').slice(0, 120),
                    ipAddress: String(req.ip || req.socket?.remoteAddress || '').slice(0, 80),
                    occurredAt: new Date()
                });
            } catch (notificationError) {
                // Authentication must never fail because an optional security
                // notification could not be queued.
                logger.warn('Failed to publish executor login security alert', {
                    error: notificationError.message
                });
            }
        }
        return res.status(200).json(mappedResponse);
    } catch (error) {
        logger.error('Mobile login failed with internal error', {
            correlationId: req.correlationId || null,
            code: error.code || 'UNKNOWN'
        });
        return sendMobileError(res, 500, 'SERVER_ERROR', 'خطأ في السيرفر', req.correlationId);
    }
};

const refreshToken = async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return sendMobileError(res, 400, 'VALIDATION_ERROR', errors.array()[0].msg, req.correlationId);
        }

        const result = await authService.refreshAccessToken(req.body.refreshToken, req);

        if (!result.success) {
            return sendMobileError(res, result.statusCode, result.code, result.message, req.correlationId);
        }

        const mappedResponse = toRefreshResponse(result);
        return res.status(200).json(mappedResponse);
    } catch (error) {
        return sendMobileError(res, 500, 'SERVER_ERROR', 'خطأ في السيرفر', req.correlationId);
    }
};

/**
 * POST /logout
 */
const logout = async (req, res) => {
    try {
        const { userId, accountType, sessionId } = req.user;
        const result = await authService.logout(userId, accountType, sessionId);
        const mappedResponse = toLogoutResponse();
        return res.json(mappedResponse);
    } catch (error) {
        return sendMobileError(res, 500, 'SERVER_ERROR', 'خطأ داخلي', req.correlationId);
    }
};

module.exports = { login, refreshToken, logout };
