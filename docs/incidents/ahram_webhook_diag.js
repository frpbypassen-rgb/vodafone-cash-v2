'use strict';

// Al-Ahram Pay merchant webhook diagnostic (v2). STRICTLY READ-ONLY.
// Only find / countDocuments / aggregate (no $out / $merge) / listIndexes are used,
// every query carries maxTimeMS, and command monitoring counts any command that
// is not on the read allow-list (the run then ends with exit code 3).
// Output: aggregate counts only. No URLs, secrets, names, phones, emails or ids.
// Env: MONGO_URI (required), TENANT_MODE, DEFAULT_TENANT_ID, DEFAULT_TENANT_SLUG,
//      DIAG_TRACE_SAMPLE (0 = short mode, 1..200 = trace sample size).
// Exit codes: 0 ok, 1 connection/query error, 2 config error, 3 non-read command seen.

const MAX_TIME_MS = 15000;
const WINDOW_HOURS = 48;
const WINDOW_MS = WINDOW_HOURS * 60 * 60 * 1000;
const STALE_SENDING_MINUTES = 15;
const TRACE_CAP = 200;
const ENDPOINT_CAP = 20000;
const PAIR_CHUNK = 100;
const EVENT = 'transfer.completed';
const DELIVERY_STATUSES = ['pending', 'sending', 'delivered', 'failed'];
const READ_COMMANDS = new Set([
    'find', 'aggregate', 'count', 'getMore', 'killCursors', 'listIndexes',
    'endSessions', 'ping', 'hello', 'isMaster', 'ismaster', 'buildInfo', 'buildinfo'
]);

const out = (line) => process.stdout.write(`${line === undefined ? '' : line}\n`);
const clean = (value) => String(value === undefined || value === null ? '' : value).trim();

// ---------- safe error reporting (never prints raw messages) ----------
const TOKEN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const NET_CODES = new Set([
    'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'EHOSTUNREACH',
    'ENETUNREACH', 'EPIPE', 'ECONNABORTED', 'ESERVFAIL', 'ENODATA', 'ETIMEOUT',
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID'
]);

const collectErrorFacts = (error) => {
    const facts = { names: [], codeNames: [], numericCodes: [], netCodes: [] };
    const seen = new Set();
    const visit = (value, depth) => {
        if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return;
        seen.add(value);
        if (typeof value.name === 'string' && TOKEN.test(value.name)) facts.names.push(value.name);
        if (typeof value.codeName === 'string' && TOKEN.test(value.codeName)) facts.codeNames.push(value.codeName);
        if (typeof value.code === 'number' && Number.isInteger(value.code)) facts.numericCodes.push(value.code);
        if (typeof value.code === 'string' && NET_CODES.has(value.code)) facts.netCodes.push(value.code);
        visit(value.cause, depth + 1);
        visit(value.error, depth + 1);
        const reason = value.reason;
        if (reason && typeof reason === 'object') {
            visit(reason.error, depth + 1);
            if (reason.servers && typeof reason.servers.forEach === 'function') {
                reason.servers.forEach((server) => visit(server && server.error, depth + 1));
            }
        }
    };
    visit(error, 0);
    return facts;
};

const classifyError = (error) => {
    const facts = collectErrorFacts(error);
    const has = (list, value) => list.indexOf(value) !== -1;
    const anyName = (re) => facts.names.some((name) => re.test(name));
    if (has(facts.codeNames, 'AuthenticationFailed') || has(facts.numericCodes, 18) || anyName(/Auth/)) {
        return ['AUTH_FAILED', 'Database authentication failed. Check the credentials in .env (not printed).'];
    }
    if (has(facts.codeNames, 'Unauthorized') || has(facts.numericCodes, 13)) {
        return ['NOT_AUTHORIZED', 'The database user is not allowed to run a read query that the diagnostic needs.'];
    }
    if (has(facts.codeNames, 'MaxTimeMSExpired') || has(facts.numericCodes, 50)) {
        return ['QUERY_TIMEOUT', `A read query exceeded maxTimeMS=${MAX_TIME_MS}. Nothing was changed.`];
    }
    if (has(facts.netCodes, 'ENOTFOUND') || has(facts.netCodes, 'EAI_AGAIN') || has(facts.netCodes, 'ESERVFAIL') || has(facts.netCodes, 'ENODATA')) {
        return ['DNS_LOOKUP_FAILED', 'The database host name could not be resolved.'];
    }
    if (facts.netCodes.some((code) => /CERT|TLS/.test(code))) {
        return ['TLS_FAILED', 'TLS negotiation with the database failed.'];
    }
    if (anyName(/Parse|InvalidArgument/)) {
        return ['BAD_CONNECTION_STRING', 'MONGO_URI could not be parsed (value not printed).'];
    }
    if (facts.netCodes.length || anyName(/ServerSelection|Network|Timeout|Topology/)) {
        return ['SERVER_UNREACHABLE', 'The database server could not be reached.'];
    }
    return ['UNEXPECTED', 'Unexpected error. Details are intentionally not printed.'];
};

const safeCode = (error) => {
    const facts = collectErrorFacts(error);
    const parts = [facts.names[0] || 'Error'];
    if (facts.codeNames[0]) parts.push(facts.codeNames[0]);
    if (facts.numericCodes.length) parts.push(`code=${facts.numericCodes[0]}`);
    if (facts.netCodes[0]) parts.push(facts.netCodes[0]);
    return parts.join('/');
};

// ---------- helpers ----------
const tenantMode = () => (clean(process.env.TENANT_MODE).toLowerCase() === 'multi' ? 'multi' : 'single');

const traceSampleSize = () => {
    const raw = clean(process.env.DIAG_TRACE_SAMPLE);
    if (!/^\d{1,6}$/.test(raw)) return { requested: 0, used: 0 };
    const requested = Number(raw);
    return { requested, used: Math.min(requested, TRACE_CAP) };
};

const opts = { maxTimeMS: MAX_TIME_MS };
const idText = (value) => (value === null || value === undefined ? '' : String(value));
const yesNo = (value) => (value ? 'yes' : 'no');

const main = async () => {
    if (!clean(process.env.MONGO_URI)) {
        out('config error: MONGO_URI is not set (checked .env and session). Refusing to run.');
        return 2;
    }
    const { MongoClient, ObjectId } = require('mongoose').mongo;
    const mode = tenantMode();
    const trace = traceSampleSize();
    const commands = { read: 0, nonRead: 0, nonReadNames: new Set() };

    const client = new MongoClient(process.env.MONGO_URI, {
        appName: 'ahram-webhook-diag-readonly',
        readPreference: 'secondaryPreferred',
        retryWrites: false,
        serverSelectionTimeoutMS: 20000,
        connectTimeoutMS: 20000,
        minPoolSize: 0,
        maxPoolSize: 4,
        monitorCommands: true
    });
    client.on('commandStarted', (event) => {
        if (READ_COMMANDS.has(event.commandName)) commands.read += 1;
        else {
            commands.nonRead += 1;
            if (TOKEN.test(event.commandName)) commands.nonReadNames.add(event.commandName);
        }
    });

    try {
        await client.connect();
        const db = client.db();
        const endpoints = db.collection('merchantwebhookendpoints');
        const deliveries = db.collection('merchantwebhookdeliveries');
        const transactions = db.collection('transactions');
        const tenants = db.collection('tenants');
        const users = db.collection('users');
        const now = Date.now();
        const since = new Date(now - WINDOW_MS);

        // ---------- tenant (from script config, mirrors middlewares/tenantResolver.js) ----------
        const tenant = { resolved: false, id: null, source: 'none', reason: 'not-configured', statusAllowed: null };
        const rawTenantId = clean(process.env.DEFAULT_TENANT_ID);
        const rawSlug = clean(process.env.DEFAULT_TENANT_SLUG).toLowerCase();
        if (rawTenantId) {
            tenant.source = 'DEFAULT_TENANT_ID';
            if (!/^[a-f\d]{24}$/i.test(rawTenantId)) tenant.reason = 'invalid-format';
            else {
                const rows = await tenants.find({ _id: new ObjectId(rawTenantId) }, { projection: { _id: 1, status: 1 } })
                    .limit(2).maxTimeMS(MAX_TIME_MS).toArray();
                if (rows.length === 1) Object.assign(tenant, { resolved: true, id: rows[0]._id, reason: 'ok', statusAllowed: ['active', 'trial'].includes(rows[0].status) });
                else tenant.reason = 'not-found';
            }
        } else if (rawSlug) {
            tenant.source = 'DEFAULT_TENANT_SLUG';
            const rows = await tenants.find({ slug: rawSlug }, { projection: { _id: 1, status: 1 } })
                .limit(2).maxTimeMS(MAX_TIME_MS).toArray();
            if (rows.length === 1) Object.assign(tenant, { resolved: true, id: rows[0]._id, reason: 'ok', statusAllowed: ['active', 'trial'].includes(rows[0].status) });
            else tenant.reason = rows.length ? 'ambiguous' : 'not-found';
        }
        const currentText = tenant.resolved ? idText(tenant.id) : null;
        const tenantScopeFilter = tenant.resolved
            ? (mode === 'multi' ? { tenantId: tenant.id } : { tenantId: { $in: [tenant.id, null] } })
            : null;

        out('config (from .env via the runner; values not printed):');
        out(`  TENANT_MODE effective: ${mode}`);
        out(`  tenant source: ${tenant.source}`);
        out(`  tenant resolved: ${yesNo(tenant.resolved)} (${tenant.reason})`);
        if (tenant.resolved) out(`  tenant status accepted by resolver (active/trial): ${yesNo(tenant.statusAllowed)}`);
        out(`  TENANT_ISOLATION_REQUIRED=true: ${yesNo(clean(process.env.TENANT_ISOLATION_REQUIRED).toLowerCase() === 'true')}${tenant.resolved ? '' : ' (if isolation is required, the app itself fails closed without a tenant)'}`);
        out('  NOTE: the tenant scope below is computed from this script\'s configuration');
        out('        (TENANT_MODE / DEFAULT_TENANT_ID / DEFAULT_TENANT_SLUG from .env). It may not');
        out('        match the scope of the actual admin session. Treat "visible" numbers as estimates.');
        out('');

        // ---------- endpoints ----------
        const endpointTotal = await endpoints.countDocuments({}, opts);
        const endpointEnabled = await endpoints.countDocuments({ enabled: true }, opts);
        const endpointSubscribed = await endpoints.countDocuments({ events: EVENT }, opts);
        const endpointEligible = await endpoints.countDocuments({ enabled: true, events: EVENT }, opts);
        const endpointTenantMissing = await endpoints.countDocuments({ tenantId: { $exists: false } }, opts);
        const tenantRows = await endpoints.aggregate([
            { $group: {
                _id: '$tenantId',
                count: { $sum: 1 },
                eligible: { $sum: { $cond: [{ $and: [
                    { $eq: ['$enabled', true] },
                    { $in: [EVENT, { $cond: [{ $isArray: '$events' }, '$events', []] }] }
                ] }, 1, 0] } }
            } }
        ], opts).toArray();
        const dist = { current: 0, currentEligible: 0, nullOrMissing: 0, nullOrMissingEligible: 0, other: [], otherEligible: 0 };
        tenantRows.forEach((row) => {
            const key = row._id === null || row._id === undefined ? null : idText(row._id);
            if (key === null) { dist.nullOrMissing += row.count; dist.nullOrMissingEligible += row.eligible; }
            else if (currentText && key === currentText) { dist.current += row.count; dist.currentEligible += row.eligible; }
            else { dist.other.push(row.count); dist.otherEligible += row.eligible; }
        });
        dist.other.sort((a, b) => b - a);
        const endpointVisible = tenantScopeFilter ? await endpoints.countDocuments(tenantScopeFilter, opts) : null;

        out('endpoints (merchantwebhookendpoints):');
        out(`  total: ${endpointTotal}`);
        out(`  enabled: ${endpointEnabled}`);
        out(`  subscribed to ${EVENT}: ${endpointSubscribed}`);
        out(`  enabled AND subscribed to ${EVENT} (eligible): ${endpointEligible}`);
        out('  tenantId distribution (no ids printed):');
        out(`    matching configured default tenant: ${tenant.resolved ? `${dist.current} (eligible ${dist.currentEligible})` : 'unresolved'}`);
        out(`    null or missing: ${dist.nullOrMissing} (field missing: ${endpointTenantMissing}; eligible ${dist.nullOrMissingEligible})`);
        out(`    ${tenant.resolved ? 'other' : 'non-null (tenant unresolved)'} tenant values: ${dist.other.length} distinct; endpoint count per tenant: [${dist.other.join(', ')}] (eligible ${dist.otherEligible})`);
        out(`  visibleToAdminScope [estimate based on script config; tenantScope ${mode === 'multi' ? '{tenantId: current}' : '{tenantId:{$in:[current,null]}}'} as in routes/merchantWebhooks.js on main]: ${endpointVisible === null ? 'unresolved' : endpointVisible}`);
        if (mode === 'single') out(`  visibleToAdminScope [fix/merchant-webhooks-visibility adminAccountScope, single mode = unscoped]: ${endpointTotal}`);
        else out(`  visibleToAdminScope [fix/merchant-webhooks-visibility adminAccountScope, multi mode = same as tenantScope]: ${endpointVisible === null ? 'unresolved' : endpointVisible}`);
        out('');

        // ---------- deliveries ----------
        const deliveryTotal = await deliveries.countDocuments({}, opts);
        const statusAll = {};
        let statusKnown = 0;
        for (const status of DELIVERY_STATUSES) {
            statusAll[status] = await deliveries.countDocuments({ status }, opts);
            statusKnown += statusAll[status];
        }
        const status48 = {};
        const completed48 = {};
        for (const status of DELIVERY_STATUSES) {
            status48[status] = await deliveries.countDocuments({ status, createdAt: { $gte: since } }, opts);
            completed48[status] = await deliveries.countDocuments({ status, eventType: EVENT, createdAt: { $gte: since } }, opts);
        }
        const staleSending = await deliveries.countDocuments({
            status: 'sending', lockedAt: { $lte: new Date(now - STALE_SENDING_MINUTES * 60 * 1000) }
        }, opts);
        const sendingNoLock = await deliveries.countDocuments({ status: 'sending', lockedAt: null }, opts);
        const failedRows = await deliveries.aggregate([
            { $match: { status: 'failed' } },
            { $project: { _id: 0, cls: { $switch: { branches: [
                { case: { $not: [{ $in: [{ $type: '$responseCode' }, ['int', 'long', 'double', 'decimal']] }] }, then: 'none' },
                { case: { $lt: ['$responseCode', 300] }, then: '2xx' },
                { case: { $lt: ['$responseCode', 400] }, then: '3xx' },
                { case: { $lt: ['$responseCode', 500] }, then: '4xx' },
                { case: { $lt: ['$responseCode', 600] }, then: '5xx' }
            ], default: 'other' } } } },
            { $group: { _id: '$cls', count: { $sum: 1 } } }
        ], opts).toArray();
        const failedClasses = {};
        failedRows.forEach((row) => { failedClasses[String(row._id)] = row.count; });
        const deliveryVisible = tenantScopeFilter ? await deliveries.countDocuments(tenantScopeFilter, opts) : null;
        const fmt = (map) => Object.keys(map).sort().map((key) => `${key}=${map[key]}`).join(', ') || '(none)';

        out('deliveries (merchantwebhookdeliveries):');
        out(`  total: ${deliveryTotal}`);
        out(`  by status (all time): ${fmt(statusAll)}, other=${Math.max(0, deliveryTotal - statusKnown)}`);
        out(`  by status (created last ${WINDOW_HOURS}h): ${fmt(status48)}`);
        out(`  ${EVENT} by status (created last ${WINDOW_HOURS}h): ${fmt(completed48)}`);
        out(`  stale 'sending' (lockedAt older than ${STALE_SENDING_MINUTES} min): ${staleSending}`);
        out(`  'sending' without lockedAt: ${sendingNoLock}`);
        out(`  'failed' by HTTP response class: ${fmt(failedClasses)}`);
        out(`  visibleToAdminScope [estimate based on script config; tenantScope as on main]: ${deliveryVisible === null ? 'unresolved' : deliveryVisible}`);
        out('');

        const completedTx48 = await transactions.countDocuments({ status: 'completed', completedAt: { $gte: since } }, opts);
        out('transactions:');
        out(`  status 'completed' with completedAt in last ${WINDOW_HOURS}h: ${completedTx48}`);
        out('');

        // ---------- index presence (listIndexes only; key patterns compared, nothing printed from data) ----------
        const indexChecks = [
            [deliveries, 'merchantwebhookdeliveries', { endpointId: 1, eventId: 1 }],
            [deliveries, 'merchantwebhookdeliveries', { status: 1, nextAttemptAt: 1, lockedAt: 1 }],
            [deliveries, 'merchantwebhookdeliveries', { eventType: 1 }],
            [endpoints, 'merchantwebhookendpoints', { enabled: 1, events: 1 }],
            [transactions, 'transactions', { status: 1, completedAt: -1 }]
        ];
        const indexCache = new Map();
        out('indexes used by this diagnostic (present?):');
        for (const [collection, name, key] of indexChecks) {
            if (!indexCache.has(name)) {
                try {
                    const list = await collection.listIndexes({ maxTimeMS: MAX_TIME_MS }).toArray();
                    indexCache.set(name, list.map((index) => JSON.stringify(index.key)));
                } catch (error) {
                    indexCache.set(name, null);
                }
            }
            const keys = indexCache.get(name);
            const text = JSON.stringify(key);
            out(`  ${name} ${text}: ${keys === null ? 'unknown (collection missing or not listable)' : yesNo(keys.includes(text))}`);
        }
        out('');

        // ---------- optional trace phase ----------
        if (trace.used > 0) {
            await runTrace({ endpoints, deliveries, transactions, users, ObjectId, mode, since, trace });
        } else {
            out('trace: skipped (default SHORT mode). Run with -TraceSample N (1..200) for a sampled per-endpoint check.');
            out('');
        }

        out(`read-only check: commands observed read=${commands.read}, non-read=${commands.nonRead}${commands.nonRead ? ` [${[...commands.nonReadNames].join(',')}]` : ''}`);
        return commands.nonRead ? 3 : 0;
    } finally {
        await client.close().catch(() => {});
    }
};

const runTrace = async ({ endpoints, deliveries, transactions, users, ObjectId, mode, since, trace }) => {
    out(`trace (sample of recent completed transactions, last ${WINDOW_HOURS}h):`);
    out(`  sample requested: ${trace.requested}; used: ${trace.used} (cap ${TRACE_CAP})`);

    const txs = await transactions.find(
        { status: 'completed', completedAt: { $gte: since } },
        { projection: { _id: 1, status: 1, tenantId: 1, companyId: 1, clientActorModel: 1, clientActorId: 1, userId: 1, completedAt: 1 } }
    ).sort({ completedAt: -1 }).limit(trace.used).maxTimeMS(MAX_TIME_MS).toArray();

    const allEndpoints = await endpoints.find(
        {},
        { projection: { _id: 1, ownerModel: 1, ownerId: 1, tenantId: 1, enabled: 1, events: 1, createdAt: 1 } }
    ).limit(ENDPOINT_CAP + 1).maxTimeMS(MAX_TIME_MS).toArray();
    if (allEndpoints.length > ENDPOINT_CAP) {
        out(`  trace aborted: more than ${ENDPOINT_CAP} endpoints; sampling would be too heavy.`);
        out('');
        return;
    }
    const byOwner = new Map();
    allEndpoints.forEach((endpoint) => {
        const key = `${endpoint.ownerModel}:${idText(endpoint.ownerId)}`;
        if (!byOwner.has(key)) byOwner.set(key, []);
        byOwner.get(key).push(endpoint);
    });

    // Mirrors resolveOwner() in services/merchantWebhookService.js.
    const agentCache = new Map();
    const resolveOwner = async (tx) => {
        if (tx.companyId) return { ownerModel: 'ClientCompany', ownerId: tx.companyId };
        if (tx.clientActorModel === 'User' && tx.clientActorId) return { ownerModel: 'User', ownerId: tx.clientActorId };
        const key = idText(tx.userId);
        if (!key) return null;
        if (agentCache.has(key)) return agentCache.get(key);
        const conditions = [{ phone: key }, { webUsername: key }];
        if (/^[a-f\d]{24}$/i.test(key)) conditions.unshift({ _id: new ObjectId(key) });
        const agent = await users.find({ role: 'agent', $or: conditions }, { projection: { _id: 1 } })
            .limit(1).maxTimeMS(MAX_TIME_MS).toArray();
        const owner = agent.length ? { ownerModel: 'User', ownerId: agent[0]._id } : null;
        agentCache.set(key, owner);
        return owner;
    };

    const counts = {
        ownerUnresolved: 0, noEndpointForOwner: 0, noEligibleEndpoint: 0, withEligible: 0,
        skippedDisabled: 0, skippedNotSubscribed: 0, skippedTenantMismatchMulti: 0
    };
    const pairs = [];
    const txPairs = [];
    for (const tx of txs) {
        const owner = await resolveOwner(tx);
        if (!owner) { counts.ownerUnresolved += 1; continue; }
        const owned = byOwner.get(`${owner.ownerModel}:${idText(owner.ownerId)}`) || [];
        if (!owned.length) { counts.noEndpointForOwner += 1; continue; }
        const eventId = `${idText(tx._id)}:${EVENT}:${tx.status || ''}`;
        const mine = [];
        for (const endpoint of owned) {
            if (endpoint.enabled !== true) { counts.skippedDisabled += 1; continue; }
            if (!Array.isArray(endpoint.events) || !endpoint.events.includes(EVENT)) { counts.skippedNotSubscribed += 1; continue; }
            if (mode === 'multi' && idText(endpoint.tenantId) !== idText(tx.tenantId)) { counts.skippedTenantMismatchMulti += 1; continue; }
            const pair = {
                txId: idText(tx._id),
                endpointId: endpoint._id,
                eventId,
                tenantDiffers: Boolean(tx.tenantId) && idText(endpoint.tenantId) !== idText(tx.tenantId),
                endpointNewer: Boolean(endpoint.createdAt && tx.completedAt && endpoint.createdAt > tx.completedAt),
                exact: null,
                completedOther: null,
                otherEventOnly: false
            };
            pairs.push(pair);
            mine.push(pair);
        }
        if (mine.length) { counts.withEligible += 1; txPairs.push(mine); } else counts.noEligibleEndpoint += 1;
    }

    // Index-bounded lookup per (endpointId, transaction): uses the unique
    // {endpointId:1, eventId:1} index with an eventId range "<txId>:" .. "<txId>;".
    // One query per chunk of pairs; no collection scans, no regex, no $split.
    let lookupQueries = 0;
    for (let offset = 0; offset < pairs.length; offset += PAIR_CHUNK) {
        const chunk = pairs.slice(offset, offset + PAIR_CHUNK);
        const clauses = chunk.map((pair) => ({ endpointId: pair.endpointId, eventId: { $gte: `${pair.txId}:`, $lt: `${pair.txId};` } }));
        const rows = await deliveries.find(
            { $or: clauses },
            { projection: { _id: 0, endpointId: 1, eventId: 1, eventType: 1, status: 1 } }
        ).maxTimeMS(MAX_TIME_MS).toArray();
        lookupQueries += 1;
        const index = new Map();
        rows.forEach((row) => {
            const eventIdText = String(row.eventId || '');
            const cut = eventIdText.indexOf(':');
            const key = `${idText(row.endpointId)}|${cut === -1 ? eventIdText : eventIdText.slice(0, cut)}`;
            if (!index.has(key)) index.set(key, []);
            index.get(key).push(row);
        });
        chunk.forEach((pair) => {
            const found = index.get(`${idText(pair.endpointId)}|${pair.txId}`) || [];
            const exact = found.find((row) => row.eventType === EVENT && row.eventId === pair.eventId);
            const completedOther = found.find((row) => row.eventType === EVENT && row.eventId !== pair.eventId);
            pair.exact = exact || null;
            pair.completedOther = exact ? null : (completedOther || null);
            pair.otherEventOnly = !exact && !completedOther && found.length > 0;
        });
    }

    const withStatus = { pending: 0, sending: 0, delivered: 0, failed: 0, other: 0 };
    const missing = { total: 0, otherEventTypeOnly: 0, endpointCreatedAfterCompletion: 0, tenantIdDiffersFromTransaction: 0, noExplanation: 0 };
    let withDelivery = 0;
    let suffixDiffers = 0;
    pairs.forEach((pair) => {
        const row = pair.exact || pair.completedOther;
        if (row) {
            withDelivery += 1;
            if (!pair.exact) suffixDiffers += 1;
            const status = DELIVERY_STATUSES.includes(row.status) ? row.status : 'other';
            withStatus[status] += 1;
            return;
        }
        missing.total += 1;
        if (pair.otherEventOnly) missing.otherEventTypeOnly += 1;
        if (pair.endpointNewer) missing.endpointCreatedAfterCompletion += 1;
        if (pair.tenantDiffers) missing.tenantIdDiffersFromTransaction += 1;
        if (!pair.endpointNewer && !pair.tenantDiffers) missing.noExplanation += 1;
    });
    const coverage = { all: 0, partial: 0, none: 0 };
    txPairs.forEach((list) => {
        const got = list.filter((pair) => pair.exact || pair.completedOther).length;
        if (got === list.length) coverage.all += 1;
        else if (got === 0) coverage.none += 1;
        else coverage.partial += 1;
    });

    out(`  sampled transactions: ${txs.length}`);
    out(`    owner not resolvable: ${counts.ownerUnresolved}`);
    out(`    owner has no webhook endpoint: ${counts.noEndpointForOwner}`);
    out(`    owner has endpoints but none eligible for ${EVENT}: ${counts.noEligibleEndpoint}`);
    out(`    with >=1 eligible endpoint: ${counts.withEligible}`);
    out(`  endpoint pairs skipped (not eligible, NOT counted as missing): disabled=${counts.skippedDisabled}, not-subscribed=${counts.skippedNotSubscribed}${mode === 'multi' ? `, tenant-mismatch(multi)=${counts.skippedTenantMismatchMulti}` : ''}`);
    out(`  eligible (transaction, endpoint) pairs: ${pairs.length}`);
    out(`  pairs with a ${EVENT} delivery: ${withDelivery} (${Object.keys(withStatus).map((key) => `${key}=${withStatus[key]}`).join(', ')})`);
    out(`    of which eventId suffix differs from "<txId>:${EVENT}:completed": ${suffixDiffers}`);
    out(`  pairs MISSING a ${EVENT} delivery: ${missing.total}`);
    out(`    only other event types exist for the pair (e.g. transfer.created): ${missing.otherEventTypeOnly}`);
    out(`    endpoint created after the transaction completed: ${missing.endpointCreatedAfterCompletion}`);
    out(`    endpoint tenantId differs from transaction tenantId (main-branch enqueue filter would skip): ${missing.tenantIdDiffersFromTransaction}`);
    out(`    none of the above: ${missing.noExplanation}`);
    out(`  transactions with eligible endpoints: all delivered=${coverage.all}, partial=${coverage.partial}, none=${coverage.none}`);
    out(`  delivery lookup queries issued: ${lookupQueries}`);
    out('');
};

const fatal = (error) => {
    const [category, message] = classifyError(error);
    out(`diag error: ${category} [${safeCode(error)}] ${message}`);
    process.exit(1);
};
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
        const [category, message] = classifyError(error);
        out(`diag error: ${category} [${safeCode(error)}] ${message}`);
        process.exitCode = 1;
    });