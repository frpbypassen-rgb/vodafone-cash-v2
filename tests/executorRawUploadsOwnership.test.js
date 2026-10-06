'use strict';

const express = require('express');
const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { once } = require('events');

jest.mock('../models/Employee', () => ({ findById: jest.fn() }));
jest.mock('../models/ExecutorGroup', () => ({ findById: jest.fn() }));
jest.mock('../models/Transaction', () => ({ exists: jest.fn() }));
jest.mock('../models/SupportTicket', () => ({ exists: jest.fn() }));
jest.mock('../services/securityControlService', () => ({
    sessionPrincipal: jest.fn(), getState: jest.fn(), assessNetworkRisk: jest.fn(),
    ensureDeviceId: jest.fn(), hashDeviceId: jest.fn(), sessionDeviceRecentlyVerified: jest.fn(),
    requestChannel: jest.fn()
}));

const Employee = require('../models/Employee');
const ExecutorGroup = require('../models/ExecutorGroup');
const Transaction = require('../models/Transaction');
const SupportTicket = require('../models/SupportTicket');
const securityControl = require('../services/securityControlService');
const { enforceSecuritySession } = require('../middlewares/securityControl');
const createRawUploadsRouter = require('../routes/rawUploads');

const EMPLOYEE = '507f1f77bcf86cd799439011';
const PEER = '507f1f77bcf86cd799439012';
const GROUP = '507f1f77bcf86cd799439021';
const OTHER_GROUP = '507f1f77bcf86cd799439022';
const TENANT = '507f1f77bcf86cd799439031';
const OTHER_TENANT = '507f1f77bcf86cd799439032';
const ENV_KEYS = ['TENANT_MODE', 'TENANT_ISOLATION_REQUIRED', 'PASSWORD_ONLY_LOGIN_MODE',
    'SECURITY_VERIFICATION_ENFORCEMENT_ENABLED', 'SECURITY_VERIFICATION_MODE', 'PASSKEY_REQUIRED'];

// Independently evaluate the small Mongo query subset against synthetic records.
const fieldValues = (record, keys) => {
    if (Array.isArray(record)) return record.flatMap((item) => fieldValues(item, keys));
    if (!keys.length) return [record];
    return fieldValues(record?.[keys[0]], keys.slice(1));
};
const equal = (left, right) => right === null ? left == null : left === right;
const matches = (record, filter) => Object.entries(filter).every(([key, condition]) => {
    if (key === '$and') return condition.every((item) => matches(record, item));
    if (key === '$or') return condition.some((item) => matches(record, item));
    const values = fieldValues(record, key.split('.'));
    if (condition && typeof condition === 'object') {
        if ('$elemMatch' in condition) {
            return values.some((value) => value && typeof value === 'object' && matches(value, condition.$elemMatch));
        }
        if ('$in' in condition) return values.some((value) => condition.$in.some((allowed) => equal(value, allowed)));
        if ('$nin' in condition) return values.every((value) => condition.$nin.every((denied) => !equal(value, denied)));
        throw new Error(`Unsupported fixture query for ${key}`);
    }
    return values.some((value) => equal(value, condition));
});

describe('executor raw upload ownership at the HTTP boundary', () => {
    let uploadDir;
    let employee;
    let group;
    let transactions;
    let tickets;
    let previousEnv;

    beforeAll(() => {
        uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-raw-uploads-'));
        for (const relativePath of ['proofs/receipt.jpg', 'proofs/receipt-copy.jpg', 'proofs/private.jpg',
            'proofs/deposit.jpg', 'proofs/orphan.jpg', 'support/chat.jpg', 'unrelated.jpg', 'identity.jpg', 'receipt.jpg']) {
            const file = path.join(uploadDir, relativePath);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, `synthetic:${relativePath}`);
        }
    });

    afterAll(() => {
        if (path.dirname(uploadDir) !== os.tmpdir() || !path.basename(uploadDir).startsWith('executor-raw-uploads-')) {
            throw new Error('Unexpected test fixture directory');
        }
        fs.rmSync(uploadDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        previousEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
        process.env.TENANT_MODE = 'single';
        process.env.TENANT_ISOLATION_REQUIRED = 'false';
        process.env.PASSWORD_ONLY_LOGIN_MODE = 'false';
        process.env.SECURITY_VERIFICATION_ENFORCEMENT_ENABLED = 'true';
        process.env.SECURITY_VERIFICATION_MODE = 'required';
        process.env.PASSKEY_REQUIRED = 'false';
        jest.resetAllMocks();
        employee = { _id: EMPLOYEE, groupId: GROUP, role: 'operator', status: 'active', sessionVersion: 3, tenantId: TENANT };
        group = { _id: GROUP, status: 'active', tenantId: TENANT };
        transactions = [{ executorGroupId: GROUP, tenantId: TENANT, status: 'completed', proofImage: 'proofs/receipt.jpg' }];
        tickets = [];
        Employee.findById.mockImplementation(() => ({ select: () => ({ lean: async () => employee }) }));
        ExecutorGroup.findById.mockImplementation(() => ({ select: () => ({ lean: async () => group }) }));
        Transaction.exists.mockImplementation(async (filter) => transactions.find((record) => matches(record, filter)) || null);
        SupportTicket.exists.mockImplementation(async (filter) => tickets.find((record) => matches(record, filter)) || null);
        securityControl.sessionPrincipal.mockImplementation((session) => (
            session.isExecutorLoggedIn ? { principalType: 'executor', principalId: session.executorId } : null
        ));
        securityControl.getState.mockResolvedValue({
            accountSessionHours: 2, adminSessionHours: 2, accountDeviceEnforcementEnabled: true
        });
        securityControl.assessNetworkRisk.mockReturnValue({ highRisk: false });
        securityControl.ensureDeviceId.mockReturnValue('fixture-device');
        securityControl.hashDeviceId.mockReturnValue('a'.repeat(64));
        securityControl.sessionDeviceRecentlyVerified.mockReturnValue(true);
        securityControl.requestChannel.mockReturnValue('web');
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (previousEnv[key] === undefined) delete process.env[key];
            else process.env[key] = previousEnv[key];
        }
    });

    const buildApp = ({ session = {}, tenantId = TENANT } = {}) => {
        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.session = {
                isExecutorLoggedIn: true, executorId: EMPLOYEE, executorSessionVersion: 3,
                executorGroupId: GROUP, securityExpiresAt: Date.now() + 60000,
                ...session,
                destroy: (callback) => callback()
            };
            req.tenantId = tenantId;
            next();
        });
        app.use(enforceSecuritySession);
        app.use('/uploads', createRawUploadsRouter({ uploadDir }));
        return app;
    };
    const getFile = (url = '/uploads/proofs/receipt.jpg', options) => (
        request(buildApp(options)).get(url).set('Accept', 'application/json')
    );
    const attachment = (overrides = {}) => ({
        entityType: 'executor', entityId: EMPLOYEE,
        metadata: { executorGroupId: GROUP },
        messages: [{ imageUrl: '/uploads/support/chat.jpg', sender: 'user', messageType: 'image' }],
        ...overrides
    });
    const getRawPath = async (url) => {
        const server = buildApp().listen(0, '127.0.0.1');
        await once(server, 'listening');
        try {
            return await new Promise((resolve, reject) => {
                const req = http.get({
                    hostname: '127.0.0.1', port: server.address().port, path: url,
                    headers: { Accept: 'application/json' }
                }, (res) => {
                    res.resume();
                    res.on('end', () => resolve(res.statusCode));
                });
                req.on('error', reject);
            });
        } finally {
            await new Promise((resolve) => server.close(resolve));
        }
    };

    test.each(['operator', 'external', 'accountant', 'manager'])(
        'retains group-scoped public proofs for %s as in the portal proxy', async (role) => {
            employee.role = role;
            expect((await getFile()).status).toBe(200);
            expect(Employee.findById).toHaveBeenCalledWith(EMPLOYEE);
            expect(ExecutorGroup.findById).toHaveBeenCalledWith(GROUP);
        }
    );

    test('accepts managerGroupId ownership without granting another group access', async () => {
        transactions[0].executorGroupId = OTHER_GROUP;
        transactions[0].managerGroupId = GROUP;
        expect((await getFile()).status).toBe(200);
        transactions[0].managerGroupId = OTHER_GROUP;
        expect((await getFile()).status).toBe(403);
    });

    test.each(['proofs/receipt.jpg', '/uploads/proofs/receipt.jpg', 'uploads/proofs/receipt.jpg', 'receipt.jpg'])(
        'matches the entire stored proof reference %s', async (reference) => {
            transactions[0].proofImage = reference;
            expect((await getFile()).status).toBe(200);
            expect((await getFile('/uploads/proofs/receipt-copy.jpg')).status).toBe(403);
        }
    );

    test('allows proofImages but not the same basename in a different directory', async () => {
        transactions[0].proofImage = null;
        transactions[0].proofImages = ['proofs/receipt.jpg'];
        expect((await getFile()).status).toBe(200);
        transactions[0].proofImages = ['another/receipt.jpg'];
        expect((await getFile()).status).toBe(403);
    });

    test('a bare proof ID cannot also authorize a same-named file at the upload root', async () => {
        transactions[0].proofImage = 'receipt.jpg';
        expect((await getFile()).status).toBe(200);
        expect((await getFile('/uploads/receipt.jpg')).status).toBe(403);
    });

    test('reads employee/group afresh and ignores the stale session group', async () => {
        const app = buildApp({ session: { executorGroupId: OTHER_GROUP } });
        expect((await request(app).get('/uploads/proofs/receipt.jpg')).status).toBe(200);
        employee.status = 'suspended';
        expect((await request(app).get('/uploads/proofs/receipt.jpg')).status).toBe(403);
        expect(Employee.findById).toHaveBeenCalledTimes(2);
    });

    test.each(['missing employee', 'inactive employee', 'revoked version', 'missing group', 'inactive group', 'unknown role'])(
        'denies %s before searching for files', async (reason) => {
            if (reason === 'missing employee') employee = null;
            if (reason === 'inactive employee') employee.status = 'banned';
            if (reason === 'revoked version') employee.sessionVersion = 4;
            if (reason === 'missing group') group = null;
            if (reason === 'inactive group') group.status = 'paused';
            if (reason === 'unknown role') employee.role = 'admin';
            expect((await getFile()).status).toBe(403);
            expect(Transaction.exists).not.toHaveBeenCalled();
        }
    );

    test.each([
        { isExecutorLoggedIn: false }, { executorId: null }, { executorId: { $ne: null } },
        { executorId: 'invalid' }, { mfaEnrollmentRequired: true }
    ])('denies malformed or incomplete executor sessions: %j', async (session) => {
        expect((await getFile(undefined, { session })).status).toBe(403);
        expect(Employee.findById).not.toHaveBeenCalled();
    });

    test.each(['proofs/orphan.jpg', 'unrelated.jpg', 'support/chat.jpg'])(
        'denies an existing unrelated file %s', async (relativePath) => {
            expect((await getFile(`/uploads/${relativePath}`)).status).toBe(403);
        }
    );

    test('cannot turn a query/body filename into ownership of the requested file', async () => {
        const response = await getFile('/uploads/unrelated.jpg?path=proofs/receipt.jpg&proofImage=proofs/receipt.jpg')
            .send({ proofImage: 'proofs/receipt.jpg', executorGroupId: GROUP });
        expect(response.status).toBe(403);
    });

    test.each([
        '/uploads/proofs/%2e%2e/support/chat.jpg', '/uploads/proofs/..%5creceipt.jpg',
        '/uploads/proofs/%252e%252e/receipt.jpg', '/uploads/proofs/%00receipt.jpg',
        '/uploads/proofs/receipt.jpg:$DATA', '/uploads/proofs//receipt.jpg',
        '/uploads/proofs/receipt.jpg.', '/uploads/proofs/%ZZ.jpg', '/uploads/.env'
    ])('denies traversal, ambiguous paths or invalid encoding: %s', async (url) => {
        // Supertest normalizes encoded dot segments before sending the request.
        expect(await getRawPath(url)).toBe(403);
        expect(Transaction.exists).not.toHaveBeenCalled();
    });

    test('does not treat a remote URL or suffix as a local file reference', async () => {
        transactions[0].proofImage = 'https://remote.test/uploads/proofs/receipt.jpg';
        expect((await getFile()).status).toBe(403);
        transactions[0].proofImage = 'proofs/receipt.jpg?key=value';
        expect((await getFile()).status).toBe(403);
    });

    test.each(['idCardImage', 'oldReceiptImage', 'voiceNote', 'notes'])(
        'does not grant access based on an unrelated transaction field: %s', async (field) => {
            transactions[0][field] = '/uploads/unrelated.jpg';
            expect((await getFile('/uploads/unrelated.jpg')).status).toBe(403);
        }
    );

    test.each(['operator', 'external', 'accountant', 'manager'])(
        'keeps private sender/executor evidence manager-only for %s', async (role) => {
            employee.role = role;
            transactions[0].executorProofImages = ['proofs/private.jpg'];
            const response = await getFile('/uploads/proofs/private.jpg');
            expect(response.status).toBe(role === 'manager' ? 200 : 403);
        }
    );

    test.each(['deposit_pending', 'deposit', 'deduction'])(
        'denies legacy company funding receipts without depositRequest metadata: %s', async (status) => {
            transactions[0].status = status;
            expect((await getFile()).status).toBe(403);
            employee.role = 'accountant';
            expect((await getFile()).status).toBe(200);
        }
    );

    test('retains manager/accountant access to depositRequest receiptImages without public proof fields', async () => {
        transactions[0] = {
            executorGroupId: GROUP, tenantId: TENANT, status: 'deposit_pending',
            depositRequest: { submittedById: PEER, receiptImages: ['proofs/deposit.jpg'] }
        };
        for (const role of ['manager', 'accountant']) {
            employee.role = role;
            expect((await getFile('/uploads/proofs/deposit.jpg')).status).toBe(200);
        }
    });

    test.each(['operator', 'external', 'accountant', 'manager'])(
        'protects company deposit transaction receipts for %s', async (role) => {
            employee.role = role;
            transactions[0].proofImages = ['proofs/deposit.jpg'];
            transactions[0].depositRequest = { submittedById: PEER, receiptImages: ['proofs/deposit.jpg'] };
            expect((await getFile('/uploads/proofs/deposit.jpg')).status).toBe(
                ['manager', 'accountant'].includes(role) ? 200 : 403
            );
        }
    );

    test('permits own support attachments and manager company tickets, not peers for other roles', async () => {
        tickets = [attachment()];
        expect((await getFile('/uploads/support/chat.jpg')).status).toBe(200);
        tickets[0].entityId = PEER;
        for (const role of ['external', 'operator', 'accountant', 'manager']) {
            employee.role = role;
            expect((await getFile('/uploads/support/chat.jpg')).status).toBe(role === 'manager' ? 200 : 403);
        }
    });

    test('permits legacy admin attachments but denies user-supplied raw links', async () => {
        tickets = [attachment({ messages: [{ imageUrl: '/uploads/unrelated.jpg', sender: 'user', messageType: 'text' }] })];
        expect((await getFile('/uploads/unrelated.jpg')).status).toBe(403);
        tickets[0].messages[0].sender = 'admin';
        expect((await getFile('/uploads/unrelated.jpg')).status).toBe(200);
    });

    test('fails closed for ambiguous legacy mobile image messages stored as text', async () => {
        tickets = [attachment({
            metadata: { replyChannel: 'portal' },
            messages: [{ imageUrl: '/uploads/support/chat.jpg', sender: 'user', channel: 'portal', messageType: 'text' }]
        })];
        expect((await getFile('/uploads/support/chat.jpg')).status).toBe(403);
        tickets[0].messages[0].messageType = 'image';
        expect((await getFile('/uploads/support/chat.jpg')).status).toBe(200);
    });

    test('message type and file URL must belong to the same support message', async () => {
        tickets = [attachment({ messages: [
            { imageUrl: '/uploads/unrelated.jpg', sender: 'user', messageType: 'text' },
            { imageUrl: '/uploads/support/chat.jpg', sender: 'user', messageType: 'image' }
        ] })];
        expect((await getFile('/uploads/unrelated.jpg')).status).toBe(403);
    });

    test('blocks foreign company tickets even if entityId or filename is guessed', async () => {
        tickets = [attachment({ metadata: { executorGroupId: OTHER_GROUP } })];
        expect((await getFile('/uploads/support/chat.jpg')).status).toBe(403);
        employee.role = 'manager';
        tickets[0].entityId = PEER;
        expect((await getFile('/uploads/support/chat.jpg')).status).toBe(403);
    });

    test.each(['operator', 'external', 'accountant', 'manager'])(
        'permits only the company group chat for %s', async (role) => {
            employee.role = role;
            tickets = [attachment({
                entityType: 'executor_group', entityId: GROUP,
                groupChatKey: `executor-group:${GROUP}`, metadata: { conversationType: 'execution_group' }
            })];
            expect((await getFile('/uploads/support/chat.jpg')).status).toBe(200);
            tickets[0].entityId = OTHER_GROUP;
            expect((await getFile('/uploads/support/chat.jpg')).status).toBe(403);
        }
    );

    test.each(['operator', 'external', 'accountant', 'manager'])(
        'permits company deposit support attachments only for privileged roles: %s', async (role) => {
            employee.role = role;
            tickets = [attachment({ entityType: 'executor_group', entityId: GROUP, metadata: { type: 'executor_deposit' } })];
            expect((await getFile('/uploads/support/chat.jpg')).status).toBe(
                ['manager', 'accountant'].includes(role) ? 200 : 403
            );
            tickets[0].entityId = OTHER_GROUP;
            expect((await getFile('/uploads/support/chat.jpg')).status).toBe(403);
        }
    );

    test('does not allow client support tickets or arbitrary group ticket types', async () => {
        for (const entityType of ['client_user', 'client_company', 'executor_group']) {
            tickets = [attachment({ entityType, entityId: GROUP, metadata: {} })];
            expect((await getFile('/uploads/support/chat.jpg')).status).toBe(403);
        }
    });

    test.each(['employee', 'group', 'transaction'])(
        'rejects cross-tenant %s records', async (record) => {
            if (record === 'employee') employee.tenantId = OTHER_TENANT;
            if (record === 'group') group.tenantId = OTHER_TENANT;
            if (record === 'transaction') transactions[0].tenantId = OTHER_TENANT;
            expect((await getFile()).status).toBe(403);
        }
    );

    test('uses single-tenant legacy scope without opening multi-tenant legacy records', async () => {
        delete employee.tenantId;
        delete group.tenantId;
        delete transactions[0].tenantId;
        expect((await getFile()).status).toBe(200);
        process.env.TENANT_MODE = 'multi';
        expect((await getFile()).status).toBe(403);
    });

    test('requires a resolved tenant in multi-tenant mode and scopes every transaction query', async () => {
        process.env.TENANT_MODE = 'multi';
        expect((await getFile()).status).toBe(200);
        expect(Transaction.exists.mock.calls[0][0].$and[0]).toEqual({ tenantId: TENANT });
        expect((await getFile(undefined, { tenantId: null })).status).toBe(403);
    });

    test('expired security sessions never reach the ownership lookup', async () => {
        const response = await getFile(undefined, { session: { securityExpiresAt: Date.now() - 1 } });
        expect(response.status).toBe(401);
        expect(response.body.code).toBe('SECURITY_SESSION_EXPIRED');
        expect(Employee.findById).not.toHaveBeenCalled();
    });

    test('device enforcement is not skipped for raw image requests', async () => {
        securityControl.ensureDeviceId.mockReturnValue(null);
        const response = await getFile();
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('DEVICE_BINDING_MISMATCH');
        expect(Employee.findById).not.toHaveBeenCalled();
    });

    test('security guard failures are closed before static files', async () => {
        securityControl.getState.mockRejectedValueOnce(new Error('unavailable'));
        const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            expect((await getFile()).status).toBe(503);
            expect(Employee.findById).not.toHaveBeenCalled();
        } finally {
            errorLog.mockRestore();
        }
    });

    test.each(['employee', 'group', 'transaction', 'ticket'])(
        'fails closed when the %s lookup fails', async (model) => {
            if (model === 'employee') Employee.findById.mockImplementationOnce(() => { throw new Error('database-secret'); });
            if (model === 'group') ExecutorGroup.findById.mockImplementationOnce(() => { throw new Error('database-secret'); });
            if (model === 'transaction') Transaction.exists.mockRejectedValueOnce(new Error('database-secret'));
            if (model === 'ticket') { transactions = []; SupportTicket.exists.mockRejectedValueOnce(new Error('database-secret')); }
            const response = await getFile();
            expect(response.status).toBe(503);
            expect(response.text).not.toContain('database-secret');
        }
    );

    test('retains administrator raw file access and master-only account documents', async () => {
        const session = { isLoggedIn: true, isExecutorLoggedIn: false, adminRole: 'admin' };
        expect((await getFile('/uploads/unrelated.jpg', { session })).status).toBe(200);
        expect((await getFile('/uploads/account-documents/identity.jpg', { session })).status).toBe(403);
        session.adminRole = 'master';
        expect((await getFile('/uploads/account-documents/identity.jpg', { session })).status).toBe(200);
        expect(Employee.findById).not.toHaveBeenCalled();
    });

    test.each(['/uploads/proofs/receipt.jpg', '/uploads/account-documents/identity.jpg'])(
        'keeps clients blocked even with mixed principal flags: %s', async (url) => {
            expect((await getFile(url, { session: { isClientLoggedIn: true, isLoggedIn: true, adminRole: 'master' } })).status).toBe(403);
        }
    );

    test('does not let executors read account documents through a stored reference', async () => {
        transactions[0].proofImage = 'account-documents/identity.jpg';
        expect((await getFile('/uploads/account-documents/identity.jpg')).status).not.toBe(200);
        expect((await getFile('/uploads/%61ccount-documents/identity.jpg')).status).not.toBe(200);
    });

    test('authorizes HEAD and range requests without any static fallback on denial', async () => {
        const app = buildApp();
        const head = await request(app).head('/uploads/proofs/receipt.jpg');
        expect(head.status).toBe(200);
        expect(head.headers['cache-control']).toBe('private, no-store');
        expect(head.text).toBeUndefined();
        expect((await request(app).get('/uploads/proofs/receipt.jpg').set('Range', 'bytes=0-3')).status).toBe(206);
        transactions = [];
        expect((await request(app).head('/uploads/proofs/receipt.jpg')).status).toBe(403);
        expect((await request(app).get('/uploads/proofs/receipt.jpg').set('If-None-Match', head.headers.etag)).status).toBe(403);
        expect((await request(app).get('/uploads/proofs/receipt.jpg').set('Range', 'bytes=0-3')).status).toBe(403);
    });

    test('does not expose a directory listing or serve a missing authorized file', async () => {
        expect((await getFile('/uploads/proofs/')).status).toBe(403);
        transactions[0].proofImage = 'proofs/missing.jpg';
        expect((await getFile('/uploads/proofs/missing.jpg')).status).toBe(404);
    });

    test('production mounts every raw upload after tenant and security enforcement', () => {
        const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
        const mount = source.indexOf("app.use('/uploads', createRawUploadsRouter(");
        expect(mount).toBeGreaterThan(source.indexOf('app.use(tenantResolver)'));
        expect(mount).toBeGreaterThan(source.indexOf('app.use(enforceSecuritySession)'));
        expect(mount).toBeGreaterThan(source.indexOf('app.use(enforceEmergencyLockdown)'));
        expect(source.match(/app\.use\('\/uploads/g)).toHaveLength(1);
        expect(source).not.toContain("express.static(path.join(__dirname, 'uploads'))");
    });
});
