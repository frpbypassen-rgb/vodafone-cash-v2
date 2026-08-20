'use strict';

const {
    maskIdentifier,
    sanitizeLogInfo,
    sanitizeLogValue
} = require('../utils/logSanitizer');
const { summarizeEventForLog } = require('../services/eventBus');

describe('structured log sanitizer', () => {
    test('redacts secrets and masks nested personal identifiers', () => {
        const sanitized = sanitizeLogValue({
            password: 'DoNotLogThis',
            accessToken: 'token-value',
            tx: {
                vodafoneNumber: '01108172258',
                serviceDetails: { clientPhone: '0940719000' },
                customId: 'ATT-2608-0001'
            }
        });

        expect(sanitized).toEqual({
            password: '[REDACTED]',
            accessToken: '[REDACTED]',
            tx: {
                vodafoneNumber: '011******58',
                serviceDetails: { clientPhone: '094*****00' },
                customId: 'ATT-2608-0001'
            }
        });
    });

    test('keeps operational fields while sanitizing logger metadata in place', () => {
        const info = {
            level: 'info',
            message: 'request',
            correlationId: 'request-123',
            phone: '01012345678',
            apiKey: 'private-key'
        };

        expect(sanitizeLogInfo(info)).toMatchObject({
            correlationId: 'request-123',
            phone: '010******78',
            apiKey: '[REDACTED]'
        });
        expect(maskIdentifier('0912345678')).toBe('091*****78');
    });

    test('event bus log summary excludes the raw transaction payload', () => {
        const summary = summarizeEventForLog('transfer:completed', {
            tx: {
                customId: 'ATT-2608-0001',
                status: 'completed',
                vodafoneNumber: '01108172258',
                amount: 100,
                proofImage: 'proof.jpg'
            },
            emp: { name: 'Executor' }
        });

        expect(summary).toEqual({
            eventName: 'transfer:completed',
            customId: 'ATT-2608-0001',
            status: 'completed',
            tenantId: undefined,
            hasProof: true
        });
        expect(summary).not.toHaveProperty('vodafoneNumber');
        expect(summary).not.toHaveProperty('amount');
        expect(summary).not.toHaveProperty('emp');
    });
});
