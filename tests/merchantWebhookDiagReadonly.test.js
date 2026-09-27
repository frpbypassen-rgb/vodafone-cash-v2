'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient, ObjectId } = require('mongodb');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

jest.setTimeout(180000);

const SCRIPT = path.join(__dirname, '../docs/incidents/ahram_webhook_diag.js');
const DB_NAME = 'webhook_diag';
const ROOT_USER = 'diagroot';
const ROOT_PASS = 'diagrootpass';
const READER_USER = 'webhookreader';
const READER_PASS = 'webhookreaderpass';

let replSet;
let rootUri;
let readerUri;
let rootClient;

const withAuth = (baseUri, user, pass, authSource) => {
    const withUser = baseUri.replace(
        'mongodb://',
        `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`
    );
    const joiner = withUser.includes('?') ? '&' : '?';
    return `${withUser}${joiner}authSource=${encodeURIComponent(authSource)}`;
};

const runScript = (env) => new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], {
        env: { PATH: process.env.PATH, ...env },
        cwd: path.join(__dirname, '..')
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
});

const hashOf = (id) => crypto.createHash('sha256').update(String(id)).digest('hex').slice(0, 8);

beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
        replSet: {
            count: 1,
            name: 'rsDiag',
            dbName: DB_NAME,
            storageEngine: 'wiredTiger',
            auth: {
                enable: true,
                customRootName: ROOT_USER,
                customRootPwd: ROOT_PASS,
                extraUsers: [{
                    database: DB_NAME,
                    createUser: READER_USER,
                    pwd: READER_PASS,
                    roles: [{ role: 'read', db: DB_NAME }]
                }]
            }
        }
    });
    const baseUri = replSet.getUri(DB_NAME);
    rootUri = withAuth(baseUri, ROOT_USER, ROOT_PASS, 'admin');
    readerUri = withAuth(baseUri, READER_USER, READER_PASS, DB_NAME);
    rootClient = new MongoClient(rootUri);
    await rootClient.connect();

    const current = new ObjectId();
    const legacy = new ObjectId();
    const other = new ObjectId();
    const companyLegacy = new ObjectId();
    const companyCurrent = new ObjectId();
    const userNone = new ObjectId();
    const userOther = new ObjectId();
    const gapTx = new ObjectId();
    const coveredTx = new ObjectId();
    const recent = new Date(Date.now() - (60 * 60 * 1000));
    const older = new Date(Date.now() - (2 * 60 * 60 * 1000));
    const db = rootClient.db(DB_NAME);

    await db.collection('tenants').insertMany([
        { _id: current, slug: 'current-slug', name: 'hidden-current-name', status: 'active' },
        { _id: legacy, slug: 'legacy-slug', name: 'hidden-legacy-name', status: 'active' },
        { _id: other, slug: 'other-slug', name: 'hidden-other-name', status: 'active' }
    ]);
    await db.collection('users').insertOne({
        _id: userNone,
        role: 'agent',
        phone: '0910000000',
        webUsername: 'agent-secret-name',
        balance: 12345
    });
    await db.collection('merchantwebhookendpoints').insertMany([
        {
            tenantId: legacy,
            ownerModel: 'ClientCompany',
            ownerId: companyLegacy,
            enabled: true,
            events: ['transfer.completed'],
            url: 'https://secret.example/legacy',
            secretEncrypted: 'secret-legacy',
            name: 'Legacy Co'
        },
        {
            tenantId: null,
            ownerModel: 'User',
            ownerId: userNone,
            enabled: true,
            events: ['transfer.completed'],
            url: 'https://secret.example/none',
            secretEncrypted: 'secret-none',
            name: 'None User'
        },
        {
            tenantId: current,
            ownerModel: 'ClientCompany',
            ownerId: companyCurrent,
            enabled: true,
            events: ['transfer.completed'],
            url: 'https://secret.example/current',
            secretEncrypted: 'secret-current',
            name: 'Current Co'
        },
        {
            tenantId: current,
            ownerModel: 'ClientCompany',
            ownerId: companyCurrent,
            enabled: false,
            events: ['transfer.completed'],
            url: 'https://secret.example/disabled',
            secretEncrypted: 'secret-disabled',
            name: 'Disabled Co'
        },
        {
            tenantId: other,
            ownerModel: 'User',
            ownerId: userOther,
            enabled: true,
            events: ['transfer.completed'],
            url: 'https://secret.example/other',
            secretEncrypted: 'secret-other',
            name: 'Other Tenant'
        }
    ]);
    await db.collection('merchantwebhookdeliveries').insertMany([
        {
            tenantId: current,
            status: 'pending',
            endpointId: new ObjectId(),
            ownerModel: 'ClientCompany',
            ownerId: companyCurrent,
            eventId: `${coveredTx}:transfer.completed:completed`,
            eventType: 'transfer.completed',
            payload: { secret: 'payload-secret', url: 'https://secret.example/payload' },
            responseCode: null
        },
        {
            tenantId: legacy,
            status: 'failed',
            responseCode: 500,
            responsePreview: 'secret-body',
            endpointId: new ObjectId(),
            ownerModel: 'ClientCompany',
            ownerId: companyLegacy,
            eventId: 'legacy-event:transfer.completed:completed',
            eventType: 'transfer.completed',
            payload: { url: 'https://secret.example/failed' }
        },
        {
            tenantId: null,
            status: 'failed',
            responseCode: 404,
            endpointId: new ObjectId(),
            ownerModel: 'User',
            ownerId: userNone,
            eventId: 'none-event:transfer.completed:completed',
            eventType: 'transfer.completed',
            payload: { phone: '0910000000' }
        },
        {
            tenantId: current,
            status: 'sending',
            lockedAt: new Date(Date.now() - (10 * 60 * 1000)),
            endpointId: new ObjectId(),
            ownerModel: 'ClientCompany',
            ownerId: companyCurrent,
            eventId: 'stale-event:transfer.completed:completed',
            eventType: 'transfer.completed',
            payload: { amount: 99999 }
        },
        {
            tenantId: current,
            status: 'sending',
            lockedAt: new Date(),
            endpointId: new ObjectId(),
            ownerModel: 'ClientCompany',
            ownerId: companyCurrent,
            eventId: 'fresh-event:transfer.completed:completed',
            eventType: 'transfer.completed',
            payload: { amount: 1 }
        },
        {
            tenantId: other,
            status: 'delivered',
            responseCode: 200,
            endpointId: new ObjectId(),
            ownerModel: 'User',
            ownerId: userOther,
            eventId: 'other-event:transfer.completed:completed',
            eventType: 'transfer.completed',
            payload: { name: 'hidden-other-name' }
        }
    ]);
    await db.collection('transactions').insertMany([
        {
            _id: gapTx,
            customId: 'ATT-GAP-SECRET',
            status: 'completed',
            completedAt: recent,
            amount: 99999,
            tenantId: current,
            companyId: companyLegacy,
            vodafoneNumber: '01099998888',
            companyName: 'Secret Company'
        },
        {
            _id: coveredTx,
            customId: 'ATT-COVERED-SECRET',
            status: 'completed',
            completedAt: older,
            amount: 111,
            tenantId: current,
            companyId: companyCurrent,
            vodafoneNumber: '01011112222'
        }
    ]);

    rootClient.__fixture = {
        current,
        legacy,
        other,
        gapTx
    };
});

afterAll(async () => {
    if (rootClient) await rootClient.close();
    if (replSet) await replSet.stop();
});

const oplogWrites = async (since) => {
    const oplog = rootClient.db('local').collection('oplog.rs');
    return oplog.find({
        ts: { $gt: since },
        ns: new RegExp(`^${DB_NAME}\\.`)
    }).toArray();
};

const lastOplogTs = async () => {
    const last = await rootClient.db('local').collection('oplog.rs')
        .find()
        .sort({ $natural: -1 })
        .limit(1)
        .next();
    return last.ts;
};

test('the diagnostic script has no write operations and refuses an unset MONGO_URI', () => {
    const source = fs.readFileSync(SCRIPT, 'utf8');
    expect(source).toContain('autoIndex');
    expect(source).toContain('autoCreate');
    expect(source).toContain("mongoose.set('autoIndex', false)");
    expect(source).toContain("mongoose.set('autoCreate', false)");
    expect(source).not.toMatch(/insertOne|insertMany|updateOne|updateMany|deleteOne|deleteMany|findOneAndUpdate|findOneAndDelete|bulkWrite|replaceOne|createIndex|ensureIndex|syncIndexes/);
    const refused = spawnSync(process.execPath, [SCRIPT], {
        env: { PATH: process.env.PATH },
        cwd: path.join(__dirname, '..')
    });
    expect(refused.status).not.toBe(0);
    expect(refused.stderr.toString()).toMatch(/MONGO_URI is unset/);
    expect(refused.stdout.toString()).not.toMatch(/mongodb:\/\//);
});

test('read-only user cannot write, and the script adds no oplog entries', async () => {
    const reader = new MongoClient(readerUri);
    await reader.connect();
    await expect(reader.db(DB_NAME).collection('merchantwebhookendpoints').insertOne({
        ownerModel: 'User',
        url: 'https://secret.example/write'
    })).rejects.toThrow(/not authorized/i);
    await reader.close();

    const fixture = rootClient.__fixture;
    const since = await lastOplogTs();
    const single = await runScript({
        MONGO_URI: readerUri,
        TENANT_MODE: 'single',
        DEFAULT_TENANT_ID: String(fixture.current)
    });
    expect(single.code).toBe(0);
    expect(single.stderr).toBe('');
    const singleReport = JSON.parse(single.stdout);
    const writesAfterSingle = await oplogWrites(since);
    expect(writesAfterSingle).toEqual([]);

    const slugSince = await lastOplogTs();
    const bySlug = await runScript({
        MONGO_URI: readerUri,
        TENANT_MODE: 'single',
        DEFAULT_TENANT_SLUG: 'current-slug'
    });
    expect(bySlug.code).toBe(0);
    expect(await oplogWrites(slugSince)).toEqual([]);

    const multiSince = await lastOplogTs();
    const multi = await runScript({
        MONGO_URI: readerUri,
        TENANT_MODE: 'multi',
        DEFAULT_TENANT_ID: String(fixture.current)
    });
    expect(multi.code).toBe(0);
    expect(await oplogWrites(multiSince)).toEqual([]);
    const multiReport = JSON.parse(multi.stdout);

    const forbidden = [
        'secret.example',
        'secret-legacy',
        '0910000000',
        '01099998888',
        'Secret Company',
        'hidden-current-name',
        'hidden-legacy-name',
        'agent-secret-name',
        'ATT-GAP-SECRET',
        '99999',
        '12345',
        'payload-secret',
        'mongodb://',
        String(fixture.current),
        String(fixture.legacy),
        String(fixture.other)
    ];
    const combined = `${single.stdout}\n${bySlug.stdout}\n${multi.stdout}`;
    forbidden.forEach((token) => {
        expect(combined).not.toContain(token);
    });

    expect(singleReport).toMatchObject({
        readOnly: true,
        tenantMode: 'single',
        currentTenantResolved: true,
        adminScope: 'single-current-or-null',
        endpoints: {
            total: 5,
            enabled: 4,
            disabled: 1,
            byOwnerModel: { ClientCompany: 3, User: 2 },
            visibleToAdminScope: 3
        },
        deliveries: {
            byStatus: { delivered: 1, failed: 2, pending: 1, sending: 2 },
            staleSending: 1,
            failureResponseCodes: { '404': 1, '500': 1 }
        },
        completedWithoutDelivery: {
            windowHours: 48,
            count: 1,
            sample: {
                tenantCategory: 'current',
                ownerModel: 'ClientCompany',
                resolveOwnerFound: true,
                endpointMatchesOwner: true,
                tenantMatchFails: true
            }
        }
    });
    expect(singleReport.endpoints.byTenantCategory).toEqual({
        current: 2,
        none: 1,
        [`other-${hashOf(fixture.legacy)}`]: 1,
        [`other-${hashOf(fixture.other)}`]: 1
    });
    expect(JSON.parse(bySlug.stdout).endpoints.visibleToAdminScope).toBe(3);
    expect(multiReport.tenantMode).toBe('multi');
    expect(multiReport.adminScope).toBe('multi-exact');
    expect(multiReport.endpoints.visibleToAdminScope).toBe(2);
    expect(multiReport.completedWithoutDelivery.count).toBe(1);

    const counts = await rootClient.db(DB_NAME).collection('merchantwebhookendpoints').countDocuments();
    expect(counts).toBe(5);
});
