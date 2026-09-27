# Merchant webhook visibility

Diagnosis against production main `6cc6d02bb9e077edb23ba65233e9bea3f7e69dca`. Previous production HEAD was `527c782193433b9cd9c88d6f403d6f2eb1171817`. This document does not change data, create indexes, send webhooks, merge, or deploy.

Delivery is at-least-once. Merchants dedupe with the `x-ahrampay-event-id` header. A retry can repeat an HTTP call the merchant already accepted.

## Verdict

Two code defects hide or skip legacy webhook rows in single-tenant mode. Both are older than the `527c782..6cc6d02` deploy. A third defect leaves crashed `sending` rows unselected by the worker. The admin page paints a successful empty payload as zeros, and it does not say so when the load failed. The worker switch added in that deploy can stop HTTP delivery, and it cannot empty the endpoint list. The company integrations routes had the same single-tenant hide. This branch shows a company its own legacy endpoints and does not use the open admin scope on those routes.

Status: mechanism proven from code; production confirmation pending. The production root cause is not confirmed until the production diagnostic output is received. Whether stored rows are in the legacy-tenant shape, and whether the running PM2 process is staging or has the worker switch off, needs that read-only diagnostic and the PM2 env check below.

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

`utils/tenantScope.js:35-38` `adminAccountScope` returns `{}` in single mode and `tenantScope` in multi mode. Account and ledger admin views already use it. The webhook admin routes did not. The company routes at `6cc6d02b` used the same `tenantScope` inside `endpointScope` (around lines 40-44, and the client list at 55-62). This branch replaces that company filter. The admin line numbers above are the pre-fix code.

**Needs production data to confirm** this is why `/admin/webhooks` is empty on this host. mechanism proven from code; production confirmation pending. The v2 diagnostic prints counts only. `visibleToAdminScope` is an estimate from the script config (`TENANT_MODE`, `DEFAULT_TENANT_ID`, `DEFAULT_TENANT_SLUG`), not from the live admin session. If the configured tenant does not resolve, that line is `unresolved`. If endpoints `total` is 0, the endpoints are absent (case a). If `total` is greater than the tenantScope estimate, rows sit outside that estimate.

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
| (a) Endpoints do not exist | Possible. Not proven. | v2 diagnostic, endpoints `total: 0` |
| (b) Endpoints exist and the admin scope hides them | Proven mechanism | endpoints `total` greater than the `visibleToAdminScope` tenantScope estimate, or that line is `unresolved` |
| (c) Completion creates no delivery | Proven when tenant ids differ, or `resolveOwner` misses | SHORT mode does not sample this. Optional `-TraceSample` (capped at 200) prints missing-delivery pair counts |
| (d) Delivery is pending, failed, or stuck `sending` | Stuck `sending` is proven. Pending and failed are normal queue states | `by status` lines and `stale 'sending'` |
| (e) Merchant server rejected the call | Code stores `responseCode` on non-2xx (`services/merchantWebhookService.js:142` and `:159`) | `'failed' by HTTP response class`. Needs production data |

## Impact

No webhook path in this diagnosis writes `Ledger`, `Transaction` balances, or `AuditLog`. Customer and executor balances do not move because a callback was skipped. The operational loss is that a merchant who subscribed to `transfer.created`, `transfer.completed`, or `transfer.cancelled` does not get the HTTP call, so their own fulfillment or reconciliation does not run. Support sees an empty admin page and cannot retry a legacy delivery, because the retry lookup uses the same filter. A stuck `sending` row can mean the merchant already processed the event. Auto-resending every historical stuck row would repeat that side effect. This fix does not do that.

At `6cc6d02b` the company integrations routes (`routes/merchantWebhooks.js` `endpointScope` via `tenantScope`, around lines 40-62) hide a historical tenant id the same way the admin page did. This branch changes those routes. Single mode lists and manages endpoints owned by the authenticated company, including a legacy or missing `tenantId`. Multi mode keeps the exact request tenant and ownership. Another company's endpoints and deliveries stay unreachable for view, update, delete, and retry. Company routes do not call `adminAccountScope` and do not use an empty filter. No stored `tenantId` is rewritten. A company manager is still the existing check: role `owner`, or `canManageCompany`.

## Reproduction

Tests in `tests/merchantWebhookVisibility.test.js`. They use the local Mongo memory replica set and a mocked HTTP client (public DNS answer `203.0.113.10`, no socket to a merchant). At `6cc6d02b` the admin query and the exact tenant match contradict the assertions below.

- Single mode: a legacy-tenant endpoint is in `GET /admin/api/webhooks` and `enqueueTransactionWebhook` creates a delivery for it. Before the fix the list filter is `{ tenantId: { $in: [current, null] } }` and the enqueue filter is `tenantId: transaction.tenantId`, so both miss the legacy row.
- Single mode: a no-tenant endpoint is listed, and a transaction that has the current tenant id still creates a delivery. The old enqueue filter misses that endpoint.
- Multi mode, two tenants, same `ownerModel` + `ownerId`: tenant A's admin response does not contain tenant B's endpoint or delivery, retry returns 404, and enqueue writes a delivery only for tenant A's endpoint. A transaction with no tenant id matches only an unscoped endpoint, not tenant B.
- Stale `sending` whose `lockedAt` is after `MERCHANT_WEBHOOK_STALE_SENDING_RECLAIM_AFTER` and older than 2 minutes is posted with the same `x-ahrampay-event-id`. A row locked before the cutoff is not posted. With the variable unset, a stale `sending` row is not posted. `attemptCount >= 6` is not posted.
- `classifyAdminWebhookLoad(500, { success: false })` and a 200 body with `success: false` are failures. A 200 body with `success: true` and empty arrays is a real empty result.
- Single mode, company routes: the signed-in company sees and can update, retry, and delete its own legacy-tenant endpoint and a missing-tenant endpoint. It cannot view, update, delete, or retry another company's endpoint or delivery, including a same-tenant row and a legacy-tenant row owned by the other company. `tenantId` values stay as stored. User `balance` and the `Ledger` row stay equal.
- Multi mode, two tenants: a same-`ownerId` endpoint in the other tenant is not listed, updated, deleted, or retried. A missing-tenant row for that owner is not visible. A sub-user whose role is not `owner` and whose `canManageCompany` is false receives 403 on list, page, delete, and retry. An employee with `canManageCompany` can list the company's endpoint in the request tenant. With no request tenant, the company lookup matches nothing.
- User `balance` and the `Ledger` row are equal before and after enqueue plus delivery.
- `isMerchantWebhookWorkerEnabled({ NODE_ENV: 'production' })` is true when the switch is unset. `{ NODE_ENV: 'staging' }` and `{ NODE_ENV: 'production', APP_ENV: 'staging' }` are false. Kept from `tests/runtimeIsolation.test.js` and repeated here.

## Fix in this branch

- Admin list, stats, and admin retry use `adminAccountScope`. Single mode sees every stored endpoint and delivery, including a historical tenant id and a missing tenant id. Multi mode stays `{ tenantId }` for the request tenant.
- Company list, update, delete, and retry use ownership (`ownerModel` + `ownerId` of the authenticated company or agency). Single mode tolerates a historical or missing `tenantId` only on rows that company owns. Multi mode also requires the exact request tenant. A missing tenant in multi mode matches nothing (`tenantId: { $in: [] }`). These routes do not call `adminAccountScope` and do not use an empty filter. The session lookup uses the same rule, still keyed by the session id, and still requires role `owner` or `canManageCompany` (agency staff still require `canManageAgent`). New endpoints still store `tenantWriteId(req)`. Existing `tenantId` values are not rewritten.
- Single-mode enqueue no longer adds `tenantId` to the endpoint query. `ownerModel` + `ownerId` + `enabled` + event remain the boundary. Multi mode sets `tenantId` to the transaction's tenant id, or `null` when the transaction has none, so it cannot attach to another tenant's endpoint.
- `processPendingWebhooks` selects a stale `sending` row only when `MERCHANT_WEBHOOK_STALE_SENDING_RECLAIM_AFTER` parses as a time and `lockedAt` is strictly after that time and at least 2 minutes old. Leave the variable unset until separately approved. Unset or invalid means the worker does not auto-retry any stale `sending` row and does not backfill missed events. Older rows stay for `node scripts/listStaleSendingWebhooks.js`, which prints counts and delivery ids only. Resend remains the existing admin or company retry, as a separate approved action. The header stays `x-ahrampay-event-id`.
- `/admin/webhooks` uses `classifyAdminWebhookLoad`. HTTP failure, `success !== true`, or a body without the arrays shows `تعذر تحميل مراقبة الويب هوك` and does not paint zeros.
- No migration, no new index, no `tenantId` rewrite, no endpoint delete, no secret rotation, no balance or ledger write.

## Browser check of the load message

A local page served the real `views/admin_webhooks.ejs` and `public/js/admin-webhooks.js`. Chrome showed the failure sentence for HTTP 500 and for HTTP 200 with `success: false` and empty arrays, with no endpoint metric. HTTP 200 with `success: true` and empty arrays showed the zero metrics and `لا توجد نقاط`. Screenshot: `/opt/cursor/artifacts/screenshots/admin-webhooks-http-500.png`.

## Read-only diagnostic

Run the diagnostic once, in SHORT mode, from the production repo directory. Do not pass `-TraceSample`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\ahram_webhook_diag_run.ps1
```

SHORT mode is the default (`-TraceSample 0`). It prints aggregate counts only: no URLs, secrets, names, phone numbers, emails, or ids. Trace is optional. `-TraceSample N` also samples that many recent completed transactions; values above 200 are capped at 200. The reviewed runner is the PowerShell block below. The Node script it embeds is `docs/incidents/ahram_webhook_diag.js`, byte-identical to that here-string.

`visibleToAdminScope` is an estimate computed from this script's configuration (`TENANT_MODE`, `DEFAULT_TENANT_ID`, `DEFAULT_TENANT_SLUG` read from `.env`). It may not match the scope of the actual admin session. If the configured tenant does not resolve, those scope numbers are `unresolved`. mechanism proven from code; production confirmation pending.

### Zero-write evidence

`tests/merchantWebhookDiagReadonly.test.js` started a `mongodb-memory-server` replica set (`rsDiag`, WiredTiger) with auth. Root seeded `webhook_diag`. User `webhookreader` has role `read` on that database only. `insertOne` as that user was rejected (MongoDB not-authorized). The v2 script then ran three times as that user, in SHORT mode (no `DIAG_TRACE_SAMPLE`): single mode with `DEFAULT_TENANT_ID`, single mode with `DEFAULT_TENANT_SLUG=current-slug`, and multi mode with `DEFAULT_TENANT_ID`.

Before each run the test stored the last `local.oplog.rs` timestamp. After each run, oplog entries with `ns` matching `^webhook_diag\.` and a newer timestamp were `[]`. The endpoint count stayed 5. Output was counts only.

Seed, and the single-mode lines the test read from stdout:

- endpoints `total: 5`, `enabled: 4`, eligible for `transfer.completed`: 4
- `visibleToAdminScope` tenantScope estimate (current or null): 3
- single-mode `adminAccountScope` line (unscoped): 5
- multi mode on the same data: tenantScope `visibleToAdminScope` estimate 2, and the multi `adminAccountScope` line is the same 2
- deliveries `total: 6`; by status pending 1, failed 2, sending 2, delivered 1
- `stale 'sending'` uses a 15-minute lock age, so the 10-minute lock in the seed is not counted (0). The fresh lock is not counted either
- `'failed' by HTTP response class`: `4xx=1, 5xx=1`
- stdout did not contain the seeded URL, secret, phone, company name, custom id, amount, balance, payload, or raw tenant id
- unset `MONGO_URI`: exit code 2, stdout `MONGO_URI is not set`, and the URI is not printed

## PowerShell: diagnostic

Run once on the production host, in SHORT mode, with no `-TraceSample`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\ahram_webhook_diag_run.ps1
```

The block below is the reviewed v2 runner, verbatim. It writes the embedded script to a random temp file, loads only `MONGO_URI`, `TENANT_MODE`, `DEFAULT_TENANT_ID`, `DEFAULT_TENANT_SLUG`, and `TENANT_ISOLATION_REQUIRED` from the repo `.env`, and restores every environment variable it touches (including `NODE_PATH` and `DIAG_TRACE_SAMPLE`), `ErrorActionPreference`, and the working directory, even on failure. It deletes only the temp file it created. It prints whether each variable exists, never the values. The here-string is byte-identical to `docs/incidents/ahram_webhook_diag.js`. Output is counts only. Scope numbers are estimates from the script config, or `unresolved` when the tenant is not resolved. Trace is optional and capped at 200. mechanism proven from code; production confirmation pending.

```powershell
<#
    Al-Ahram Pay - merchant webhook diagnostic runner (v2)

    STRICTLY READ-ONLY. It does not insert, modify or remove any document, does not
    build indexes, and never resends webhooks. Output is aggregate counts only
    (no URLs, secrets, names, phone numbers, emails or customer ids).

    Usage on the server (PowerShell 5.1 or pwsh 7):
        powershell -NoProfile -ExecutionPolicy Bypass -File .\ahram_webhook_diag_run.ps1
        powershell -NoProfile -ExecutionPolicy Bypass -File .\ahram_webhook_diag_run.ps1 -TraceSample 50
    -TraceSample 0 (default) = SHORT diagnosis. 1..200 = also sample that many recent
    completed transactions and check every eligible endpoint (values above 200 are capped).

    Session safety: only MONGO_URI, TENANT_MODE, DEFAULT_TENANT_ID, DEFAULT_TENANT_SLUG and
    TENANT_ISOLATION_REQUIRED are read from .env; together with NODE_PATH and
    DIAG_TRACE_SAMPLE they are saved first and restored exactly in finally (value if the
    variable existed, removed if it did not). $ErrorActionPreference and the current
    location are restored too. Only existence status is printed, never values.
#>
param(
    [int]$TraceSample = 0,
    [string]$RepoPath = 'C:\Users\Administrator\Desktop\vodafone-cash-v2'
)

$diagJs = @'
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
'@

# ---- Everything below only touches the CURRENT PowerShell session. ----
$diagPrevEAP = $ErrorActionPreference
$diagPrevLocation = (Get-Location).Path
$ErrorActionPreference = 'Stop'
$diagDotEnvNames = @('MONGO_URI', 'TENANT_MODE', 'DEFAULT_TENANT_ID', 'DEFAULT_TENANT_SLUG', 'TENANT_ISOLATION_REQUIRED')
$diagEnvNames = $diagDotEnvNames + @('NODE_PATH', 'DIAG_TRACE_SAMPLE')
$diagSaved = @{}
foreach ($n in $diagEnvNames) {
    $v = [System.Environment]::GetEnvironmentVariable($n, 'Process')
    $diagSaved[$n] = [pscustomobject]@{ Existed = ($null -ne $v); Value = $v }
}
Remove-Variable v -ErrorAction SilentlyContinue
$diagPushed = $false
$diagTempPath = $null
$diagTempCreated = $false
$diagExit = 'n/a'
$diagStep = 'init'

$diagTrace = $TraceSample
if ($diagTrace -lt 0) { $diagTrace = 0 }
if ($diagTrace -gt 200) { $diagTrace = 200 }

'=== Al-Ahram Pay merchant webhook diagnostic (v2) ==='
'READ-ONLY: no inserts/updates/deletes, no index builds, no webhook resend, no data changes.'
'Output: aggregate counts only (no URLs, secrets, names, phones, emails or ids).'
if ($diagTrace -gt 0) {
    'mode: TRACE (sample {0}{1}) + short diagnosis' -f $diagTrace, $(if ($TraceSample -gt 200) { ', requested value capped at 200' } else { '' })
} else {
    'mode: SHORT (default; use -TraceSample N for a sampled per-endpoint check)'
}
''

try {
    $diagStep = 'repo'
    $envFile = Join-Path $RepoPath '.env'
    if (-not (Test-Path -LiteralPath $envFile -PathType Leaf)) { throw [System.IO.FileNotFoundException]::new('ENV_FILE_NOT_FOUND') }
    $modulesDir = Join-Path $RepoPath 'node_modules'
    if (-not (Test-Path -LiteralPath (Join-Path $modulesDir 'mongoose') -PathType Container)) { throw [System.IO.DirectoryNotFoundException]::new('MONGOOSE_NOT_FOUND') }
    if (-not (Get-Command node -CommandType Application -ErrorAction SilentlyContinue)) { throw [System.Management.Automation.CommandNotFoundException]::new('NODE_NOT_FOUND') }

    # Read ONLY the needed names from .env (dotenv-like parsing: optional "export ",
    # quoted values, unquoted values end at '#'; last occurrence wins).
    # Parsing runs in a child scope so no parsed value lingers in session variables.
    $diagStep = 'dotenv'
    $diagFound = & {
        param($path, $wanted)
        $allowed = [System.Collections.Generic.HashSet[string]]::new([string[]]$wanted)
        $found = [System.Collections.Generic.List[string]]::new()
        foreach ($line in [System.IO.File]::ReadAllLines($path)) {
            $trim = $line.Trim()
            if ($trim.Length -eq 0 -or $trim.StartsWith('#')) { continue }
            if ($trim.StartsWith('export ')) { $trim = $trim.Substring(7).TrimStart() }
            $eq = $trim.IndexOf('=')
            if ($eq -lt 1) { continue }
            $name = $trim.Substring(0, $eq).Trim()
            if (-not $allowed.Contains($name)) { continue }
            $value = $trim.Substring($eq + 1).Trim()
            $q = if ($value.Length -gt 0) { $value[0] } else { [char]0 }
            if (($q -eq [char]'"' -or $q -eq [char]"'" -or $q -eq [char]'`') -and $value.IndexOf($q, 1) -gt 0) {
                $value = $value.Substring(1, $value.IndexOf($q, 1) - 1)
            } else {
                $hash = $value.IndexOf('#')
                if ($hash -ge 0) { $value = $value.Substring(0, $hash).Trim() }
            }
            if ($value.Length -gt 0) {
                [System.Environment]::SetEnvironmentVariable($name, $value, 'Process')
                if (-not $found.Contains($name)) { $found.Add($name) }
            }
        }
        , $found.ToArray()
    } $envFile $diagDotEnvNames
    foreach ($n in $diagDotEnvNames) {
        $src = if ($diagFound -contains $n) { 'set from .env' } elseif ($diagSaved[$n].Existed) { 'not in .env, inherited from session' } else { 'not set' }
        '{0}: {1}' -f $n, $src
    }
    ''

    $env:NODE_PATH = $modulesDir
    $env:DIAG_TRACE_SAMPLE = [string]$diagTrace

    # Temp file: random name, created exclusively (CreateNew fails instead of
    # overwriting an existing file). Only a file created here is removed later.
    $diagStep = 'tempfile'
    $diagTempPath = Join-Path ([System.IO.Path]::GetTempPath()) ('ahram_webhook_diag_' + [System.Guid]::NewGuid().ToString('N') + '.js')
    $fs = [System.IO.FileStream]::new($diagTempPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $diagTempCreated = $true
    try {
        $bytes = (New-Object System.Text.UTF8Encoding $false).GetBytes($diagJs)
        $fs.Write($bytes, 0, $bytes.Length)
    } finally {
        $fs.Dispose()
    }

    $diagStep = 'node'
    Push-Location -LiteralPath $RepoPath
    $diagPushed = $true
    # Native stderr must not become a terminating error in PS 5.1; the diagnostic
    # itself writes everything (including safe error codes) to stdout.
    $ErrorActionPreference = 'Continue'
    & node --no-warnings $diagTempPath
    $diagExit = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
}
catch {
    $ex = $_.Exception
    while ($ex -is [System.Management.Automation.MethodInvocationException] -and $ex.InnerException) { $ex = $ex.InnerException }
    $code = switch ($ex.Message) {
        'ENV_FILE_NOT_FOUND' { 'ENV_FILE_NOT_FOUND'; break }
        'MONGOOSE_NOT_FOUND' { 'MONGOOSE_NOT_FOUND'; break }
        'NODE_NOT_FOUND' { 'NODE_NOT_FOUND'; break }
        default {
            if ($diagStep -eq 'tempfile' -and $ex -is [System.IO.IOException]) { 'TEMP_FILE_EXISTS_OR_UNWRITABLE' }
            else { 'UNEXPECTED_' + $ex.GetType().Name }
        }
    }
    'runner error: {0} (step: {1}). Details intentionally not printed. Nothing was changed.' -f $code, $diagStep
}
finally {
    'diag exit code = {0}' -f $diagExit
    if ($diagPushed) { try { Pop-Location } catch { 'warning: could not pop location' } }
    foreach ($n in $diagEnvNames) {
        try {
            if ($diagSaved[$n].Existed) { [System.Environment]::SetEnvironmentVariable($n, $diagSaved[$n].Value, 'Process') }
            else { Remove-Item -LiteralPath ('Env:' + $n) -ErrorAction SilentlyContinue }
        } catch { 'warning: could not restore {0}' -f $n }
    }
    if ($diagTempCreated -and $diagTempPath) {
        try { [System.IO.File]::Delete($diagTempPath) } catch { 'warning: could not remove temp script' }
    }
    ''
    '--- session restore check (existence only, values never printed) ---'
    foreach ($n in $diagEnvNames) {
        $now = [System.Environment]::GetEnvironmentVariable($n, 'Process')
        $same = if ($diagSaved[$n].Existed) { ($null -ne $now) -and ($now -ceq $diagSaved[$n].Value) } else { $null -eq $now }
        '{0}: existed before={1}, exists now={2}, restored exactly={3}' -f $n, $diagSaved[$n].Existed, ($null -ne $now), $same
    }
    'location restored = {0}' -f ((Get-Location).Path -eq $diagPrevLocation)
    if ($diagTempCreated) { 'temp script removed = {0}' -f (-not (Test-Path -LiteralPath $diagTempPath)) }
    else { 'temp script: not created by this run (nothing to remove)' }
    $ErrorActionPreference = $diagPrevEAP
    'ErrorActionPreference restored = {0}' -f ($ErrorActionPreference -eq $diagPrevEAP)
    Remove-Variable diagJs, diagSaved, diagFound, now, same, fs, bytes, ex, code, src, n, envFile, modulesDir -ErrorAction SilentlyContinue
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

Leave `MERCHANT_WEBHOOK_STALE_SENDING_RECLAIM_AFTER` unset until separately approved. Do not backfill missed events. `node scripts/listStaleSendingWebhooks.js` prints counts and delivery ids for rows locked longer than 2 minutes. It does not send. Ids in `manualReviewIds` are not auto-retried while the variable is unset. Ids in `reclaimEligibleIds` are the ones the worker may post only when a cutoff is set later, under a separate approval. Any resend of a manual-review id is a separate approved admin or company retry.

## Full diagnostic script

The canonical text is `docs/incidents/ahram_webhook_diag.js`, byte-identical to the here-string in the PowerShell block above. It is repeated here so the incident file still contains the Node source.

```javascript
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
```
