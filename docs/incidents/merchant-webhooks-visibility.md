# Merchant webhook visibility

Diagnosis against production main `6cc6d02bb9e077edb23ba65233e9bea3f7e69dca`. Previous production HEAD was `527c782193433b9cd9c88d6f403d6f2eb1171817`. This document does not change data, create indexes, send webhooks, merge, or deploy.

Delivery is at-least-once. Merchants dedupe with the `x-ahrampay-event-id` header. A retry can repeat an HTTP call the merchant already accepted.

## Verdict

Two code defects hide or skip legacy webhook rows in single-tenant mode. Both are older than the `527c782..6cc6d02` deploy. A third defect leaves crashed `sending` rows unselected by the worker. The admin page paints a successful empty payload as zeros, and it does not say so when the load failed. The worker switch added in that deploy can stop HTTP delivery, and it cannot empty the endpoint list.

Whether production rows are actually in the legacy-tenant shape, and whether the running PM2 process is staging or has the worker switch off, needs the read-only diagnostic and the PM2 env check below.

## What `527c782..6cc6d02` changed

`git diff 527c782193433b9cd9c88d6f403d6f2eb1171817..6cc6d02bb9e077edb23ba65233e9bea3f7e69dca` does not touch `routes/merchantWebhooks.js`, `views/admin_webhooks.ejs`, `utils/tenantScope.js`, or `middlewares/tenantResolver.js`.

`services/merchantWebhookService.js` gains 6 lines: the `isMerchantWebhookWorkerEnabled` import, `webhookHttpDisabled`, the early return in `deliverWebhook`, the `x-ahrampay-event-id` header, and the guard in `startMerchantWebhookWorker`. The tenant match inside `enqueueTransactionWebhook` is unchanged. `services/eventBus.js` changes notification dedupe keys and split-part receipts. The `transfer:completed` listener still calls `dispatchMerchantWebhook`. `services/apiExecutionLifecycleService.js` still publishes `transfer:completed` after the Mongo transaction commits.

`routes/merchantWebhooks.js` was last changed in `901fccf0` (2026-09-18, "Add intelligent dashboards and merchant webhook operations"). That commit is an ancestor of `527c782` (2026-09-25). `adminAccountScope` landed later in `c465d341`, `11821815`, and `fb34f817` (2026-09-20) and was never applied to these routes.

So the admin page's tenant filter existed on the previous production build. If the stored endpoints use the tenant id the admin request resolves, or they have no tenant id, the page showed them before this deploy. If they carry a different historical tenant id, the page was already empty on `527c782`. This deploy did not introduce that filter.

## How a completion reaches a delivery

1. `completeApiTransaction` publishes only after commit: `services/apiExecutionLifecycleService.js:477` (`eventBus.publish('transfer:completed', { tx: completedTx, ... })`). The comment at line 406 says receipt files and `transfer:completed` run after the commit.
2. `services/eventBus.js:57` calls `dispatchMerchantWebhook('transfer.completed', data)`.
3. `services/eventBus.js:43-48` loads `enqueueTransactionWebhook` with `data.tx`.
4. `resolveOwner` (`services/merchantWebhookService.js:61-72`) uses `companyId`, then `clientActorModel === 'User'`, then a User lookup by `userId` as `_id`, phone, or `webUsername`. It does not filter by tenant.
5. The endpoint query then requires `ownerModel`, `ownerId`, `enabled: true`, and the event. At `6cc6d02b` line 180, if `transaction.tenantId` is set, it also requires `endpoint.tenantId` to be exactly that value.
6. Matching endpoints get an upserted `pending` delivery. `deliverWebhook` runs immediately, and the 30-second worker calls `processPendingWebhooks`.

The chain stops at step 5 when the transaction's tenant id and the endpoint's tenant id differ. It stops earlier at step 4 when `resolveOwner` finds no owner. It stops later, after a row exists, if the worker switch is off or the row is stuck in `sending`.

## Hypothesis results

### 1. Admin list uses `tenantScope`, so a historical tenant id is hidden

**Proven from code.** Pre-existing. Not introduced by `527c782..6cc6d02`.

`routes/merchantWebhooks.js:136-146` sets `const scope = tenantScope(req)` and uses it for the endpoint find, the delivery find, and the status aggregate. The admin retry at lines 148-155 uses the same `tenantScope(req)`.

`utils/tenantScope.js:19-26`: when a tenant id is resolved and `TENANT_MODE` is `single` (also the default), the filter is `{ tenantId: { $in: [current, null] } }`. A row whose `tenantId` is a different ObjectId does not match. `null` and missing `tenantId` do match, because `{ tenantId: null }` matches missing fields.

`utils/tenantScope.js:35-38` `adminAccountScope` returns `{}` in single mode and `tenantScope` in multi mode. Account and ledger admin views already use it. The webhook routes did not.

**Needs production data to confirm** this is why `/admin/webhooks` is empty on this host. If `visibleToAdminScope` is 0 and `byTenantCategory` is only `other-*`, this is the page bug. If `total` is 0, the endpoints are absent (case a).

### 2. Enqueue requires an exact tenant id

**Proven from code.** Pre-existing. The `+6` lines in this deploy do not touch it.

`services/merchantWebhookService.js:177-181`:

```js
const endpointQuery = { ...owner, enabled: true, events: eventType };
if (transaction.tenantId) endpointQuery.tenantId = transaction.tenantId;
```

New transactions are stamped with `req.tenant._id` (the resolved `DEFAULT_TENANT_ID` or `DEFAULT_TENANT_SLUG`). Endpoints created earlier keep the tenant id from `tenantWriteId(req)` at insert time (`routes/merchantWebhooks.js` client create). Completion does not rewrite `transaction.tenantId`. When those ids differ, no delivery row is created. `ownerModel` + `ownerId` already matched.

When the transaction has no `tenantId`, the old query does not filter tenant at all, including in multi mode.

**Needs production data to confirm** a completed transaction is in `completedWithoutDelivery` with `tenantMatchFails: true`.

### 3. Worker switch

**Proven from code.** The behavior is already what production needs. It does not explain an empty endpoint list.

`utils/runtimeControls.js:22-30`: outside staging, an unset `MERCHANT_WEBHOOK_WORKER_ENABLED` stays enabled. Only `false`, `0`, `no`, or `off` disables it. `isStagingRuntime` (`utils/runtimeControls.js:74-75`) is true when any of `NODE_ENV`, `APP_ENV`, or `ENVIRONMENT` equals `staging`. Then an unset switch is off. `utils/stagingStartupGuard.js:82` returns immediately when the process is not staging, so the guard does not disable webhooks in production.

`deliverWebhook` (`services/merchantWebhookService.js:111-112`) returns `{ skipped: true, reason: 'MERCHANT_WEBHOOK_DISABLED' }` before `claimDelivery` and before HTTP. `startMerchantWebhookWorker` (`app.js:541` calling the guard) returns null. Admin and client retry call `deliverWebhook`, so they become a no-op while the switch is off, and the route still responds `success: true`.

**Needs production data to confirm** the running `Ahram_Core_API` process is not staging and has not set the switch off. Use the PM2 command below. Do not print the rest of the environment.

### 4. The admin page does not check the response

**Proven from code.** `views/admin_webhooks.ejs` at `6cc6d02b` is one line. Its `load()` does `const r = await fetch('/admin/api/webhooks'); const d = await r.json(), s = d.summary || {}` and then reads `d.endpoints.length`. It never checks `r.ok` or `d.success`.

A successful body with empty arrays renders numeric zeros and "لا توجد نقاط". That is what the tenant filter returns. A body without `endpoints` throws, and the first paint stays blank rather than zeros. A later failed poll would leave the previous zeros on screen. The zeros reported for this incident match a successful empty payload, which hypothesis 1 produces. The missing check is still a defect: `success: false` with empty arrays would also look like zeros.

### 5. Stale `sending` rows are not polled

**Proven from code.** Pre-existing. `claimDelivery` (`services/merchantWebhookService.js:97-107`) can reclaim `status: 'sending'` when `lockedAt` is older than `LOCK_TIMEOUT_MS` (2 minutes) and `attemptCount < 6`. `processPendingWebhooks` (`services/merchantWebhookService.js:206-211`) selects only `pending` and `failed`. The worker never passes a stale `sending` id to `claimDelivery`. A crash after the row is marked `sending` and before the result is saved leaves it there. The merchant may already have accepted that HTTP call.

This does not hide endpoints. It explains deliveries that stay in `sending`.

## Symptom split

| Case | At `6cc6d02b` | How to tell on the host |
| --- | --- | --- |
| (a) Endpoints do not exist | Possible. Not proven. | Diagnostic `endpoints.total === 0` |
| (b) Endpoints exist and the admin scope hides them | Proven mechanism | `total > visibleToAdminScope`, categories `other-*` |
| (c) Completion creates no delivery | Proven when tenant ids differ, or `resolveOwner` misses | `completedWithoutDelivery.count`, sample `tenantMatchFails` / `resolveOwnerFound` |
| (d) Delivery is pending, failed, or stuck `sending` | Stuck `sending` is proven. Pending and failed are normal queue states | `deliveries.byStatus`, `staleSending` |
| (e) Merchant server rejected the call | Code stores `responseCode` on non-2xx (`services/merchantWebhookService.js:142` and `:159`) | `failureResponseCodes` histogram. Needs production data |

## Impact

No webhook path in this diagnosis writes `Ledger`, `Transaction` balances, or `AuditLog`. Customer and executor balances do not move because a callback was skipped. The operational loss is that a merchant who subscribed to `transfer.created`, `transfer.completed`, or `transfer.cancelled` does not get the HTTP call, so their own fulfillment or reconciliation does not run. Support sees an empty admin page and cannot retry a legacy delivery, because the retry lookup uses the same filter. A stuck `sending` row can mean the merchant already processed the event. Auto-resending every historical stuck row would repeat that side effect. This fix does not do that.

The client portal (`routes/merchantWebhooks.js:40-62`, `endpointScope` via `tenantScope`) has the same single-tenant hide for a historical tenant id. This change does not alter client routes. After the fix, single-tenant enqueue still creates the delivery for that endpoint. The merchant's own integrations page can still omit it until a follow-up.

## Reproduction

Tests in `tests/merchantWebhookVisibility.test.js`. They use the local Mongo memory replica set and a mocked HTTP client (public DNS answer `203.0.113.10`, no socket to a merchant). At `6cc6d02b` the admin query and the exact tenant match contradict the assertions below.

- Single mode: a legacy-tenant endpoint is in `GET /admin/api/webhooks` and `enqueueTransactionWebhook` creates a delivery for it. Before the fix the list filter is `{ tenantId: { $in: [current, null] } }` and the enqueue filter is `tenantId: transaction.tenantId`, so both miss the legacy row.
- Single mode: a no-tenant endpoint is listed, and a transaction that has the current tenant id still creates a delivery. The old enqueue filter misses that endpoint.
- Multi mode, two tenants, same `ownerModel` + `ownerId`: tenant A's admin response does not contain tenant B's endpoint or delivery, retry returns 404, and enqueue writes a delivery only for tenant A's endpoint. A transaction with no tenant id matches only an unscoped endpoint, not tenant B.
- Stale `sending` whose `lockedAt` is after `MERCHANT_WEBHOOK_STALE_SENDING_RECLAIM_AFTER` and older than 2 minutes is posted with the same `x-ahrampay-event-id`. A row locked before the cutoff is not posted. With the variable unset, a stale `sending` row is not posted. `attemptCount >= 6` is not posted.
- `classifyAdminWebhookLoad(500, { success: false })` and a 200 body with `success: false` are failures. A 200 body with `success: true` and empty arrays is a real empty result.
- User `balance` and the `Ledger` row are equal before and after enqueue plus delivery.
- `isMerchantWebhookWorkerEnabled({ NODE_ENV: 'production' })` is true when the switch is unset. `{ NODE_ENV: 'staging' }` and `{ NODE_ENV: 'production', APP_ENV: 'staging' }` are false. Kept from `tests/runtimeIsolation.test.js` and repeated here.

## Fix in this branch

- Admin list, stats, and admin retry use `adminAccountScope`. Single mode sees every stored endpoint and delivery, including a historical tenant id and a missing tenant id. Multi mode stays `{ tenantId }` for the request tenant.
- Single-mode enqueue no longer adds `tenantId` to the endpoint query. `ownerModel` + `ownerId` + `enabled` + event remain the boundary. Multi mode sets `tenantId` to the transaction's tenant id, or `null` when the transaction has none, so it cannot attach to another tenant's endpoint.
- `processPendingWebhooks` selects a stale `sending` row only when `MERCHANT_WEBHOOK_STALE_SENDING_RECLAIM_AFTER` parses as a time and `lockedAt` is strictly after that time and at least 2 minutes old. Unset or invalid means the worker does not auto-retry any stale `sending` row. Set the variable to the deploy instant after review. Older rows stay for `node scripts/listStaleSendingWebhooks.js`, which prints counts and delivery ids only. Resend remains the existing admin retry, as a separate approved action. The header stays `x-ahrampay-event-id`.
- `/admin/webhooks` uses `classifyAdminWebhookLoad`. HTTP failure, `success !== true`, or a body without the arrays shows `تعذر تحميل مراقبة الويب هوك` and does not paint zeros.
- No migration, no new index, no `tenantId` rewrite, no endpoint delete, no secret rotation, no balance or ledger write.

## Browser check of the load message

A local page served the real `views/admin_webhooks.ejs` and `public/js/admin-webhooks.js`. Chrome showed the failure sentence for HTTP 500 and for HTTP 200 with `success: false` and empty arrays, with no endpoint metric. HTTP 200 with `success: true` and empty arrays showed the zero metrics and `لا توجد نقاط`. Screenshot: `/opt/cursor/artifacts/screenshots/admin-webhooks-http-500.png`.

## Read-only diagnostic

Production use: copy the script to `%TEMP%\ahram_webhook_diag.js`, do not run it from the app tree, and do not load the full `.env` into the session. The reviewed copy is `docs/incidents/ahram_webhook_diag.js`. It reads `MONGO_URI` from the environment, exits if that variable is unset, sets mongoose `autoIndex` and `autoCreate` to false, and uses `readPreference: 'secondaryPreferred'`. It prints counts and categories only. Tenant categories are `none`, `current`, or `other-` plus an 8-character hash. It does not print URLs, secrets, payloads, names, phones, emails, or balances.

`visibleToAdminScope` is the count `tenantScope` would return for the current `TENANT_MODE` and `DEFAULT_TENANT_ID` or `DEFAULT_TENANT_SLUG`. That is the pre-fix admin page, so the gap between `total` and `visibleToAdminScope` is the hidden set. `completedWithoutDelivery` counts completed transactions in the last 48 hours (`completedAt`) whose owner has an enabled endpoint and whose id is not the prefix of any delivery `eventId`. The sample says whether the strict tenant comparison would miss every enabled endpoint for that owner.

### Zero-write evidence

`tests/merchantWebhookDiagReadonly.test.js` started a `mongodb-memory-server` replica set (`rsDiag`, WiredTiger) with auth. Root seeded `webhook_diag`. User `webhookreader` has role `read` on that database only. `insertOne` as that user was rejected (MongoDB not-authorized). The script then ran three times as that user: single mode with `DEFAULT_TENANT_ID`, single mode with `DEFAULT_TENANT_SLUG=current-slug`, and multi mode with `DEFAULT_TENANT_ID`.

Before each run the test stored the last `local.oplog.rs` timestamp. After each run, oplog entries with `ns` matching `^webhook_diag\.` and a newer timestamp were `[]`. The endpoint count stayed 5.

Seed, and the single-mode result the test parsed from stdout:

- endpoints: total 5, enabled 4, disabled 1, ownerModel ClientCompany 3 and User 2
- categories: `current` 2, `none` 1, `other-<hash>` 1 for the legacy tenant, `other-<hash>` 1 for the second tenant
- `adminScope: "single-current-or-null"`, `visibleToAdminScope: 3` (current + none; legacy and the other tenant hidden)
- multi mode on the same data: `adminScope: "multi-exact"`, `visibleToAdminScope: 2`
- deliveries: pending 1, failed 2, sending 2, delivered 1
- `staleSending: 1` (the fresh `sending` lock was not counted)
- `failureResponseCodes: { "404": 1, "500": 1 }`
- `completedWithoutDelivery.count: 1`, sample `{ tenantCategory: "current", ownerModel: "ClientCompany", resolveOwnerFound: true, endpointMatchesOwner: true, tenantMatchFails: true }`
- stdout did not contain the seeded URL, secret, phone, company name, custom id, amount, balance, payload, or raw tenant id
- unset `MONGO_URI`: non-zero exit, stderr `MONGO_URI is unset. Refusing to run.`

## PowerShell: diagnostic

Run on the production host. The here-string is the full script. It is written to `%TEMP%` and deleted afterwards, along with `MONGO_URI`.

```powershell
$repo = 'C:\Users\Administrator\Desktop\vodafone-cash-v2'
$scriptPath = Join-Path $env:TEMP 'ahram_webhook_diag.js'
$utf8 = New-Object System.Text.UTF8Encoding $false
$script = @'
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
'@
[System.IO.File]::WriteAllText($scriptPath, $script, $utf8)

$allowed = [System.Collections.Generic.HashSet[string]]::new([string[]]@(
    'MONGO_URI', 'TENANT_MODE', 'DEFAULT_TENANT_ID', 'DEFAULT_TENANT_SLUG', 'TENANT_ISOLATION_REQUIRED'
))
foreach ($line in [System.IO.File]::ReadAllLines((Join-Path $repo '.env'))) {
    $trim = $line.Trim()
    if ($trim.Length -eq 0 -or $trim.StartsWith('#')) { continue }
    $eq = $trim.IndexOf('=')
    if ($eq -lt 1) { continue }
    $name = $trim.Substring(0, $eq).Trim()
    if (-not $allowed.Contains($name)) { continue }
    $value = $trim.Substring($eq + 1).Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
    }
    Set-Item -Path "Env:$name" -Value $value
}

$env:NODE_PATH = Join-Path $repo 'node_modules'
Push-Location $repo
try {
    node $scriptPath
} finally {
    Pop-Location
    Remove-Item Env:MONGO_URI -ErrorAction SilentlyContinue
    Remove-Item Env:TENANT_MODE -ErrorAction SilentlyContinue
    Remove-Item Env:DEFAULT_TENANT_ID -ErrorAction SilentlyContinue
    Remove-Item Env:DEFAULT_TENANT_SLUG -ErrorAction SilentlyContinue
    Remove-Item Env:TENANT_ISOLATION_REQUIRED -ErrorAction SilentlyContinue
    Remove-Item $scriptPath -Force -ErrorAction SilentlyContinue
}
```

## PowerShell: PM2 env allow-list

```powershell
$ids = pm2 id Ahram_Core_API | ConvertFrom-Json
$pm2Id = @($ids)[0]
pm2 env $pm2Id | Select-String -Pattern '^\s*(NODE_ENV|APP_ENV|ENVIRONMENT|MERCHANT_WEBHOOK_WORKER_ENABLED|TENANT_MODE|DEFAULT_TENANT_ID|DEFAULT_TENANT_SLUG|TENANT_ISOLATION_REQUIRED|EXTERNAL_API_ENABLED|BULLMQ_WORKERS_ENABLED|FINANCIAL_SCHEDULERS_ENABLED)\s*:'
```

Report those lines only. If `NODE_ENV`, `APP_ENV`, or `ENVIRONMENT` is `staging`, an unset `MERCHANT_WEBHOOK_WORKER_ENABLED` is off and `deliverWebhook` returns `skipped` without HTTP. In production, unset means enabled.

## Browser DevTools

On the affected admin session, open `/admin/webhooks`. In DevTools, Network, select the `GET /admin/api/webhooks` request. Record only:

- HTTP status
- JSON `success`
- `endpoints.length`
- `deliveries.length`
- `Object.keys(summary)` and each count

Do not copy URLs, names, payloads, response bodies beyond those fields, or the cookie. A 200 with `success: true` and `endpoints.length === 0` matches the scope filter. A non-200 or `success: false` is a load failure. After this branch, that failure shows the Arabic load-error sentence instead of zeros.

## Stuck `sending` listing

After deploy review, `node scripts/listStaleSendingWebhooks.js` prints counts and delivery ids for rows locked longer than 2 minutes. It does not send. Ids in `manualReviewIds` are not auto-retried. Ids in `reclaimEligibleIds` are the ones the worker may post when the cutoff is set. Any resend of a manual-review id is a separate approved admin retry.

## Full diagnostic script

```javascript
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
```
