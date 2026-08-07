'use strict';

const { body, query, validationResult } = require('express-validator');
const { sendMobileError } = require('../mappers/mobileErrorMapper');

const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        const first = errors.array()[0];
        return sendMobileError(res, 400, 'VALIDATION_ERROR', first.msg, req.correlationId);
    }
    next();
};

const createSubAccountValidator = [
    body('name')
        .trim()
        .notEmpty().withMessage('Ø§Ù„Ø§Ø³Ù… Ù…Ø·Ù„ÙˆØ¨')
        .isLength({ min: 2, max: 100 }).withMessage('Ø§Ù„Ø§Ø³Ù… ÙŠØ¬Ø¨ Ø£Ù† ÙŠÙƒÙˆÙ† Ø¨ÙŠÙ† 2 Ùˆ100 Ø­Ø±Ù'),
    body('phone')
        .optional({ checkFalsy: true })
        .trim()
        .isLength({ min: 5, max: 30 }).withMessage('Ø±Ù‚Ù… Ø§Ù„Ù‡Ø§ØªÙ ØºÙŠØ± ØµØ§Ù„Ø­'),
    body('username')
        .trim()
        .notEmpty().withMessage('Ø§Ø³Ù… Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… Ù…Ø·Ù„ÙˆØ¨')
        .isLength({ min: 3, max: 50 }).withMessage('Ø§Ø³Ù… Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… ÙŠØ¬Ø¨ Ø£Ù† ÙŠÙƒÙˆÙ† Ø¨ÙŠÙ† 3 Ùˆ50 Ø­Ø±Ù')
        .custom((val) => {
            if (/\s/.test(val)) {
                throw new Error('Ø§Ø³Ù… Ø§Ù„Ù…Ø³ØªØ®Ø¯Ù… Ù„Ø§ ÙŠÙ…ÙƒÙ† Ø£Ù† ÙŠØ­ØªÙˆÙŠ Ø¹Ù„Ù‰ Ù…Ø³Ø§ÙØ§Øª');
            }
            return true;
        }),
    body('password')
        .trim()
        .notEmpty().withMessage('ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± Ù…Ø·Ù„ÙˆØ¨Ø©')
        .isLength({ min: 10, max: 100 }).withMessage('ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± ÙŠØ¬Ø¨ Ø£Ù† ØªÙƒÙˆÙ† 10 Ø£Ø­Ø±Ù Ø¹Ù„Ù‰ Ø§Ù„Ø£Ù‚Ù„')
        .custom((value) => {
            if (!/[A-Za-z]/.test(value)) {
                throw new Error('ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± ÙŠØ¬Ø¨ Ø£Ù† ØªØ­ØªÙˆÙŠ Ø¹Ù„Ù‰ Ø­Ø±Ù ÙˆØ§Ø­Ø¯ Ø¹Ù„Ù‰ Ø§Ù„Ø£Ù‚Ù„');
            }
            if (!/\d/.test(value)) {
                throw new Error('ÙƒÙ„Ù…Ø© Ø§Ù„Ù…Ø±ÙˆØ± ÙŠØ¬Ø¨ Ø£Ù† ØªØ­ØªÙˆÙŠ Ø¹Ù„Ù‰ Ø±Ù‚Ù… ÙˆØ§Ø­Ø¯ Ø¹Ù„Ù‰ Ø§Ù„Ø£Ù‚Ù„');
            }
            return true;
        }),
    body('creditLimit')
        .optional()
        .isFloat({ min: 0 }).withMessage('Ø§Ù„Ø­Ø¯ Ø§Ù„ØªØ£Ù…ÙŠÙ†ÙŠ ÙŠØ¬Ø¨ Ø£Ù† ÙŠÙƒÙˆÙ† Ø£ÙƒØ¨Ø± Ù…Ù† Ø£Ùˆ ÙŠØ³Ø§ÙˆÙŠ Ø§Ù„ØµÙØ±'),
    body('customMargin')
        .optional()
        .isFloat({ min: 0 }).withMessage('Ù‡Ø§Ù…Ø´ Ø§Ù„Ø±Ø¨Ø­ Ù„Ù„ØªØ­ÙˆÙŠÙ„ ÙŠØ¬Ø¨ Ø£Ù† ÙŠÙƒÙˆÙ† Ø£ÙƒØ¨Ø± Ù…Ù† Ø£Ùˆ ÙŠØ³Ø§ÙˆÙŠ Ø§Ù„ØµÙØ±'),
    body('marginPiasters')
        .optional()
        .isInt({ min: 0, max: 500 }).withMessage('Ù‡Ø§Ù…Ø´ Ø§Ù„Ø±Ø¨Ø­ Ø¨Ø§Ù„Ù‚Ø±ÙˆØ´ ÙŠØ¬Ø¨ Ø£Ù† ÙŠÙƒÙˆÙ† Ø¨ÙŠÙ† 0 Ùˆ500'),
    validate
];

const updateCreditLimitValidator = [
    body('creditLimit')
        .notEmpty().withMessage('Ø§Ù„Ø­Ø¯ Ø§Ù„ØªØ£Ù…ÙŠÙ†ÙŠ Ù…Ø·Ù„ÙˆØ¨')
        .isFloat({ min: 0 }).withMessage('Ø§Ù„Ø­Ø¯ Ø§Ù„ØªØ£Ù…ÙŠÙ†ÙŠ ÙŠØ¬Ø¨ Ø£Ù† ÙŠÙƒÙˆÙ† Ø£ÙƒØ¨Ø± Ù…Ù† Ø£Ùˆ ÙŠØ³Ø§ÙˆÙŠ Ø§Ù„ØµÙØ±'),
    validate
];

const settlementValidator = [
    body('type')
        .trim()
        .notEmpty().withMessage('Ù†ÙˆØ¹ Ø§Ù„Ø¹Ù…Ù„ÙŠØ© Ù…Ø·Ù„ÙˆØ¨')
        .isIn(['deposit', 'withdraw']).withMessage('Ù†ÙˆØ¹ Ø§Ù„Ø¹Ù…Ù„ÙŠØ© ØºÙŠØ± ØµØ§Ù„Ø­ØŒ Ø§Ù„Ù…Ø³Ù…ÙˆØ­: deposit Ø£Ùˆ withdraw'),
    body('amount')
        .notEmpty().withMessage('Ø§Ù„Ù…Ø¨Ù„Øº Ù…Ø·Ù„ÙˆØ¨')
        .isFloat({ gt: 0 }).withMessage('Ø§Ù„Ù…Ø¨Ù„Øº ÙŠØ¬Ø¨ Ø£Ù† ÙŠÙƒÙˆÙ† Ø£ÙƒØ¨Ø± Ù…Ù† Ø§Ù„ØµÙØ±'),
    body('notes')
        .optional()
        .trim()
        .isLength({ max: 250 }).withMessage('Ø§Ù„Ù…Ù„Ø§Ø­Ø¸Ø§Øª Ù„Ø§ ØªØªØ¬Ø§ÙˆØ² 250 Ø­Ø±ÙØ§Ù‹')
        .escape(),
    validate
];

const updateStatusValidator = [
    body('status')
        .trim()
        .notEmpty().withMessage('Ø§Ù„Ø­Ø§Ù„Ø© Ù…Ø·Ù„ÙˆØ¨Ø©')
        .isIn(['active', 'banned']).withMessage('Ø§Ù„Ø­Ø§Ù„Ø© ØºÙŠØ± ØµØ§Ù„Ø­Ø©ØŒ Ø§Ù„Ù…Ø³Ù…ÙˆØ­: active Ø£Ùˆ banned'),
    validate
];

const paginationValidator = [
    query('page')
        .optional()
        .isInt({ min: 1 }).withMessage('Ø±Ù‚Ù… Ø§Ù„ØµÙØ­Ø© ØºÙŠØ± ØµØ§Ù„Ø­'),
    query('limit')
        .optional()
        .isInt({ min: 1, max: 50 }).withMessage('Ø¹Ø¯Ø¯ Ø§Ù„Ø¹Ù†Ø§ØµØ± ÙÙŠ Ø§Ù„ØµÙØ­Ø© ØºÙŠØ± ØµØ§Ù„Ø­ (Ø¨ÙŠÙ† 1 Ùˆ50)'),
    query('search')
        .optional()
        .trim()
        .isLength({ max: 80 }).withMessage('ÙƒÙ„Ù…Ø© Ø§Ù„Ø¨Ø­Ø« Ù„Ø§ ØªØªØ¬Ø§ÙˆØ² 80 Ø­Ø±ÙØ§Ù‹'),
    validate
];

module.exports = {
    createSubAccountValidator,
    updateCreditLimitValidator,
    settlementValidator,
    updateStatusValidator,
    paginationValidator
};
