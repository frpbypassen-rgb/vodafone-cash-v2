'use strict';

// Read-only merchant webhook diagnostic.
// Copy to %TEMP% on the host. It reads MONGO_URI from the environment and
// refuses to start when that variable is unset. It does not load dotenv.
// Output is aggregate counts and non-sensitive metadata only.

const crypto = require('crypto');

const LOCK_TIMEOUT_MS = 2 * 60 * 1000;
const WINDOW_MS = 48 * 60 * 60 * 1000;

const fail = (message) => {
    console.error(message);
    process.exit(1);
};

if (!String(process.env.MONGO_URI || '').trim()) {
    fail('MONGO_URI is unset. Refusing to run.');
}

const mongoose = require('mongoose');

mongoose.set('autoIndex', false);
mongoose.set('autoCreate', false);
mongoose.set('strictQuery', true);

const shortHash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8);

const asObjectId = (value) => {
    const text = String(value || '').trim();
    if (!/^[a-f\d]{24}$/i.test(text)) return null;
    return new mongoose.Types.ObjectId(text);
};

const tenantMode = () => {
    const configured = String(process.env.TENANT_MODE || '').trim().toLowerCase();
    return configured === 'multi' ? 'multi' : 'single';
};

const sortedCounts = (map) => Object.fromEntries(
    Object.entries(map).sort(([left], [right]) => left.localeCompare(right))
);

const addCount = (map, key, count) => {
    map[key] = (map[key] || 0) + count;
};

const categoryOf = (tenantId, currentId) => {
    if (tenantId === null || tenantId === undefined) return 'none';
    if (currentId && String(tenantId) === String(currentId)) return 'current';
    return `other-${shortHash(tenantId)}`;
};

const scopeKind = (mode, currentId) => {
    if (!currentId) return 'unscoped';
    if (mode === 'multi') return 'multi-exact';
    return 'single-current-or-null';
};

const visibleFilter = (mode, currentId) => {
    if (!currentId) return {};
    if (mode === 'multi') return { tenantId: currentId };
    return { tenantId: { $in: [currentId, null] } };
};

const resolveCurrentTenantId = async (db) => {
    const fromId = asObjectId(process.env.DEFAULT_TENANT_ID);
    if (fromId) return fromId;
    const slug = String(process.env.DEFAULT_TENANT_SLUG || '').trim().toLowerCase();
    if (!slug) return null;
    const tenant = await db.collection('tenants').findOne(
        { slug },
        { projection: { _id: 1 } }
    );
    return tenant ? tenant._id : null;
};

const resolveOwner = async (db, tx, cache) => {
    if (tx.companyId) return { ownerModel: 'ClientCompany', ownerId: tx.companyId };
    if (tx.clientActorModel === 'User' && tx.clientActorId) {
        return { ownerModel: 'User', ownerId: tx.clientActorId };
    }
    const key = String(tx.userId || '');
    if (!key) return null;
    if (cache.has(key)) return cache.get(key);
    const conditions = [{ phone: key }, { webUsername: key }];
    const objectId = asObjectId(key);
    if (objectId) conditions.unshift({ _id: objectId });
    const agent = await db.collection('users').findOne(
        { role: 'agent', $or: conditions },
        { projection: { _id: 1 } }
    );
    const owner = agent ? { ownerModel: 'User', ownerId: agent._id } : null;
    cache.set(key, owner);
    return owner;
};

const deliveryIdSet = async (deliveries, ids) => {
    const found = new Set();
    const chunkSize = 500;
    for (let offset = 0; offset < ids.length; offset += chunkSize) {
        const chunk = ids.slice(offset, offset + chunkSize);
        const rows = await deliveries.aggregate([
            { $project: { eventPrefix: { $arrayElemAt: [{ $split: ['$eventId', ':'] }, 0] } } },
            { $match: { eventPrefix: { $in: chunk } } },
            { $group: { _id: '$eventPrefix' } }
        ]).toArray();
        rows.forEach((row) => found.add(String(row._id)));
    }
    return found;
};

const tenantMatchFails = (tx, ownerEndpoints) => {
    if (!tx.tenantId) return false;
    const txTenant = String(tx.tenantId);
    return !ownerEndpoints.some((endpoint) => endpoint.tenantId && String(endpoint.tenantId) === txTenant);
};

const redact = (value) => String(value || 'failed').replace(/mongodb(\+srv)?:\/\/\S+/gi, '[redacted]');

const main = async () => {
    const mode = tenantMode();
    await mongoose.connect(process.env.MONGO_URI, {
        autoIndex: false,
        autoCreate: false,
        readPreference: 'secondaryPreferred',
        serverSelectionTimeoutMS: 20000,
        minPoolSize: 0,
        maxPoolSize: 5
    });
    const db = mongoose.connection.db;
    const endpoints = db.collection('merchantwebhookendpoints');
    const deliveries = db.collection('merchantwebhookdeliveries');
    const transactions = db.collection('transactions');
    const currentId = await resolveCurrentTenantId(db);

    const endpointGroups = await endpoints.aggregate([
        { $project: { tenantId: 1, ownerModel: 1, enabled: 1 } },
        { $group: {
            _id: { tenantId: '$tenantId', ownerModel: '$ownerModel', enabled: '$enabled' },
            count: { $sum: 1 }
        } }
    ]).toArray();

    const byTenantCategory = {};
    const byOwnerModel = {};
    let total = 0;
    let enabled = 0;
    let disabled = 0;
    endpointGroups.forEach((row) => {
        const count = row.count || 0;
        const id = row._id || {};
        total += count;
        if (id.enabled) enabled += count;
        else disabled += count;
        addCount(byTenantCategory, categoryOf(id.tenantId, currentId), count);
        addCount(byOwnerModel, id.ownerModel || 'unknown', count);
    });

    const visibleToAdminScope = await endpoints.countDocuments(visibleFilter(mode, currentId));

    const statusRows = await deliveries.aggregate([
        { $project: { status: 1 } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
    ]).toArray();
    const byStatus = {};
    statusRows.forEach((row) => { byStatus[String(row._id || 'none')] = row.count; });

    const deliveryTenantRows = await deliveries.aggregate([
        { $project: { tenantId: 1 } },
        { $group: { _id: '$tenantId', count: { $sum: 1 } } }
    ]).toArray();
    const deliveriesByTenant = {};
    deliveryTenantRows.forEach((row) => {
        addCount(deliveriesByTenant, categoryOf(row._id, currentId), row.count || 0);
    });

    const staleBefore = new Date(Date.now() - LOCK_TIMEOUT_MS);
    const staleSending = await deliveries.countDocuments({
        status: 'sending',
        lockedAt: { $lte: staleBefore }
    });

    const failureRows = await deliveries.aggregate([
        { $match: { status: 'failed' } },
        { $project: { responseCode: 1 } },
        { $group: { _id: '$responseCode', count: { $sum: 1 } } }
    ]).toArray();
    const failureResponseCodes = {};
    failureRows.forEach((row) => {
        const key = row._id === null || row._id === undefined ? 'none' : String(row._id);
        failureResponseCodes[key] = row.count;
    });

    const enabledEndpoints = await endpoints.find(
        { enabled: true },
        { projection: { tenantId: 1, ownerModel: 1, ownerId: 1 } }
    ).toArray();
    const byOwner = new Map();
    enabledEndpoints.forEach((endpoint) => {
        const key = `${endpoint.ownerModel}:${String(endpoint.ownerId)}`;
        if (!byOwner.has(key)) byOwner.set(key, []);
        byOwner.get(key).push(endpoint);
    });

    const since = new Date(Date.now() - WINDOW_MS);
    const cursor = transactions.find(
        { status: 'completed', completedAt: { $gte: since } },
        { projection: {
            tenantId: 1,
            companyId: 1,
            clientActorModel: 1,
            clientActorId: 1,
            userId: 1,
            completedAt: 1
        } }
    ).sort({ completedAt: -1, _id: -1 });

    const candidates = [];
    const ownerCache = new Map();
    for await (const tx of cursor) {
        const owner = await resolveOwner(db, tx, ownerCache);
        if (!owner) continue;
        const ownerEndpoints = byOwner.get(`${owner.ownerModel}:${String(owner.ownerId)}`);
        if (!ownerEndpoints || !ownerEndpoints.length) continue;
        candidates.push({
            id: String(tx._id),
            tenantCategory: categoryOf(tx.tenantId, currentId),
            ownerModel: owner.ownerModel,
            tenantMatchFails: tenantMatchFails(tx, ownerEndpoints)
        });
    }

    const withDelivery = candidates.length
        ? await deliveryIdSet(deliveries, candidates.map((item) => item.id))
        : new Set();
    const missing = candidates.filter((item) => !withDelivery.has(item.id));
    const sample = missing[0] ? {
        tenantCategory: missing[0].tenantCategory,
        ownerModel: missing[0].ownerModel,
        resolveOwnerFound: true,
        endpointMatchesOwner: true,
        tenantMatchFails: missing[0].tenantMatchFails
    } : null;

    const report = {
        readOnly: true,
        tenantMode: mode,
        currentTenantResolved: Boolean(currentId),
        adminScope: scopeKind(mode, currentId),
        endpoints: {
            total,
            enabled,
            disabled,
            byTenantCategory: sortedCounts(byTenantCategory),
            byOwnerModel: sortedCounts(byOwnerModel),
            visibleToAdminScope
        },
        deliveries: {
            byStatus: sortedCounts(byStatus),
            byTenantCategory: sortedCounts(deliveriesByTenant),
            staleSending,
            failureResponseCodes: sortedCounts(failureResponseCodes)
        },
        completedWithoutDelivery: {
            windowHours: 48,
            count: missing.length,
            sample
        }
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
};

main()
    .catch((error) => {
        console.error(redact(error && error.message));
        process.exitCode = 1;
    })
    .finally(async () => {
        await mongoose.disconnect().catch(() => {});
    });
