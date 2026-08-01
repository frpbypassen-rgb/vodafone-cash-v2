// tests/mobileNoRawFields.test.js
// ===============================================
// 🛡️ Security Check — منع تسريب الحقول الخام (Forbidden Fields Scanner)
// ===============================================
'use strict';

const {
    toSubAccountListItemDto,
    toSubAccountDetailsDto,
    toSubAccountTransactionDto
} = require('../mappers/mobileAgentSubAccountMapper');

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
    '__v',
    'rateLevel1',
    'rateLevel2',
    'rateLevel3',
    'settings'
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

    test('Mobile endpoints DTO payloads must not leak any raw settings fields or forbidden fields', () => {
        const loginResponse = {
            success: true,
            token: 'jwt-token',
            refreshToken: 'jwt-refresh-token',
            id: 'user-id',
            accountType: 'client_user',
            name: 'Client User',
            balance: 500,
            tier: 1,
            tierLabel: 'مستوى 1',
            baseExchangeRate: 6.40,
            exchangeRate: 6.40,
            serviceRates: {
                vodafone: 6.40,
                post_account: 6.35,
                post_card: 6.25
            },
            isOpen: true,
            context: {
                clientCompanyId: null,
                clientCompanyName: null,
                executorBotId: null,
                executorBotName: null
            }
        };

        const found = scanForForbiddenFields(loginResponse, ['token', 'refreshToken', 'context.executorBotId']);
        expect(found).toEqual([]);

        const badResponse = {
            ...loginResponse,
            rateLevel1: 6.40,
            settings: { rateLevel2: 6.45 }
        };
        const foundBad = scanForForbiddenFields(badResponse, ['token', 'refreshToken']);
        expect(foundBad).toContain('rateLevel1');
        expect(foundBad).toContain('settings');
        expect(foundBad).toContain('settings.rateLevel2');
    });

    test('Agent sub-account mobile DTOs must emit opaque ids instead of raw Mongo ids', () => {
        const sub = {
            _id: '64a111111111111111111111',
            name: 'Sub POS',
            phone: '01000000001',
            webUsername: 'subpos',
            status: 'active',
            balance: -25,
            creditLimit: 100,
            customMargin: 0.1
        };
        const tx = {
            _id: '64b222222222222222222222',
            customId: 'ATT-2606-0001',
            status: 'pending',
            amount: 100,
            costLYD: 15,
            subAccountCostLYD: 16,
            exchangeRate: 6.4,
            transferType: 'vodafone',
            vodafoneNumber: '01011111111'
        };

        const listDto = toSubAccountListItemDto(sub);
        const detailsDto = toSubAccountDetailsDto(sub);
        const txDto = toSubAccountTransactionDto(tx);

        expect(listDto.id).toMatch(/^mob_/);
        expect(detailsDto.id).toMatch(/^mob_/);
        expect(txDto.id).toMatch(/^mob_/);
        expect(listDto.id).not.toBe(String(sub._id));
        expect(detailsDto.id).not.toBe(String(sub._id));
        expect(txDto.id).not.toBe(String(tx._id));
    });
});

module.exports = { scanForForbiddenFields };
