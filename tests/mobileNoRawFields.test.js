// tests/mobileNoRawFields.test.js
// ===============================================
// 🛡️ Security Check — منع تسريب الحقول الخام (Forbidden Fields Scanner)
// ===============================================
'use strict';

const FORBIDDEN_FIELDS = [
    'webPassword',
    'password',
    'token',        // unless it is the JWT login token returning at root
    'refreshToken', // unless it is the JWT login/refresh token returning at root
    'companyId',
    'executorBotId',
    'operatorId',
    'userId',
    'botId',
    'proofImage',
    'proofImages',
    '__v'
];

/**
 * recursively scans an object to ensure no forbidden fields exist except at specified allowed paths.
 * @param {Object} obj - The object to scan
 * @param {Array<string>} [allowedPaths=[]] - Exact dot paths allowed to exist, e.g. token, context.executorBotId
 * @returns {Array<string>} List of found forbidden paths
 */
const scanForForbiddenFields = (obj, allowedPaths = []) => {
    const found = [];
    const allowed = new Set(allowedPaths);

    const traverse = (current, path = '') => {
        if (!current || typeof current !== 'object') return;

        for (const key of Object.keys(current)) {
            const nextPath = path ? `${path}.${key}` : key;
            if (FORBIDDEN_FIELDS.includes(key)) {
                if (!allowed.has(nextPath)) found.push(nextPath);
            }
            traverse(current[key], nextPath);
        }
    };

    traverse(obj);
    return found;
};

describe('🛡️ Security Contract: Forbidden Raw Fields Scanner', () => {
    test('T041: scanForForbiddenFields helper should detect forbidden fields in objects', () => {
        const unsafeObject = {
            id: '123',
            name: 'Client User',
            webPassword: 'plainTextPasswordOrHash',
            nested: {
                __v: 0,
                userId: 'telegram-id'
            }
        };

        const found = scanForForbiddenFields(unsafeObject);
        expect(found).toContain('webPassword');
        expect(found).toContain('nested.__v');
        expect(found).toContain('nested.userId');
        expect(found.length).toBe(3);
    });

    test('T041: safe login object should pass with explicitly allowed token paths only', () => {
        const safeObject = {
            id: '123',
            name: 'Client User',
            balance: 5000,
            exchangeRate: 6.45,
            token: 'jwt-token-here',
            refreshToken: 'refresh-token-here',
            context: {
                clientCompanyId: null,
                clientCompanyName: null,
                executorBotId: 'executor-bot-context-id',
                executorBotName: 'Executor Bot'
            }
        };

        const found = scanForForbiddenFields(safeObject, ['token', 'refreshToken', 'context.executorBotId']);
        expect(found.length).toBe(0);
    });

    test('T041: transaction DTO should reject database internals and receipt file identifiers', () => {
        const unsafeTransaction = {
            id: 'tx-1',
            txId: 'ATT-001',
            status: 'completed',
            userId: 'telegram-id',
            companyId: 'company-id',
            proofImage: 'telegram-file-id',
            __v: 0
        };

        const found = scanForForbiddenFields(unsafeTransaction);
        expect(found).toEqual(expect.arrayContaining(['userId', 'companyId', 'proofImage', '__v']));
    });

    test('T041: executorBotId is only allowed inside login context, not task/transaction DTOs', () => {
        const unsafeTask = {
            id: 'task-1',
            txId: 'ATT-002',
            executorBotId: 'bot-id'
        };

        const found = scanForForbiddenFields(unsafeTask, ['context.executorBotId']);
        expect(found).toContain('executorBotId');
    });

    test('T041: safe executor task DTO should pass the scanner', () => {
        const safeTask = {
            id: 'task-1',
            txId: 'ATT-002',
            transferType: 'vodafone',
            amount: 100,
            recipientNumber: '01012345678',
            recipientName: null,
            status: 'processing',
            createdAt: new Date().toISOString(),
            emergencyAlert: null
        };

        const found = scanForForbiddenFields(safeTask);
        expect(found.length).toBe(0);
    });
});

module.exports = { scanForForbiddenFields };
