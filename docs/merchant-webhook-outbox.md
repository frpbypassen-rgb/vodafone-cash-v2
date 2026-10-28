# Atomic merchant Webhook lifecycle outbox

## Financial write boundary

`Transaction` has three hidden, bounded lifecycle slots: `merchantWebhookCreatedEvent`, `merchantWebhookCompletedEvent`, and `merchantWebhookCancelledEvent`. Each contains the event ID, immutable signed-message source snapshot, owner/tenant context, pending flag and timestamps. The event is staged in the same document write and existing Mongo session as creation/completion/cancellation. A failed financial transaction rolls the slot back too. No HTTP call runs inside a financial transaction.

Mongoose `save`/`create`, `updateOne` and `findOneAndUpdate` are the covered financial runtime paths. The latter read their source through the existing session and attach the event to the same terminal-status update. Deposits, deductions and internal balance-transfer accounting rows are excluded. Normal projections omit the slots. Historical documents are not automatically backfilled; a new terminal transition on a historical transfer does stage its event. Raw collection writes, bulk/pipeline updates, replacement writes and maintenance imports are not an event-producing API and must not be used to implement new financial lifecycle transitions without extending and testing this boundary. A transaction is still required to make the wallet, ledger and transaction atomic together.

## Recovery and delivery

The Webhook worker drains indexed pending slots, stages `MerchantWebhookDelivery` through its existing unique `(endpointId,eventId)` key, then acknowledges only the matching snapshot UUID. A crash before staging leaves the slot pending. A crash after staging but before acknowledgement retries the same delivery key. Concurrent drains cannot duplicate the durable delivery. An acknowledgement changes only its own slot and does not alter financial fields or transaction recency.

Subscription creation time is bounded by event creation time, so a newly added endpoint does not receive earlier queued history. Owner/tenant scopes and current administrative permission remain mandatory. Permission denied/no matching subscriber results in no delivery; enabling a subscription is not a historical replay API. The global worker switch still stops network delivery. Legacy in-memory event listeners remain only for records lacking the corresponding durable slot; they do not recreate a new record's snapshot after commit.

The wire contract remains at-least-once and does not promise arrival order. Delivery retry budgets, failed-only manual retry claims, HTTPS/DNS validation, private-address rejection, DNS pinning and TLS verification are unchanged.

The existing recovery timer polls every 30 seconds with bounded batches (25 rows per event slot, up to 50 due deliveries per pass). The load test calls the same drain/delivery functions directly to test correctness; its elapsed time is not a promise about timer latency or production queue capacity.

## Index rollout

The worker refuses to scan the financial collection without all three named pending indexes. The readiness summary explicitly reports missing Outbox indexes. `merchantWebhookOutboxService.ensureIndexes()` is an **explicit migration entry point**, not called from application startup. It creates three partial indexes on the relevant `pending` flag and `_id` (only pending rows are indexed).

Before production deployment, review index capacity and apply the index migration in a controlled release step. Confirm MongoDB transaction support and the existing unique idempotency index too. Do not run a full historical backfill or change production worker/proxy/process settings as part of this local verification. Removing code does not erase stored events; retain pending slots for a future compatible dispatcher.

## Receiver reference

`examples/merchant-webhook-receiver.js` exports `createReceiver({ connection, secret, receiverId })`. Use a dedicated receiver ID and secret per connected account, initialize its indexes on a replica-set/sharded Mongo connection, mount its router before any JSON body parser, and protect the public deployment with HTTPS.

The receiver authenticates the **raw body** using HMAC-SHA256 over `timestamp + '.' + rawBody`, a constant-time comparison, and a five-minute timestamp window. Deduplication uses the signed body `id`, not the unsigned event-ID header. An inbox receipt and mirrored state update commit together. Reusing a signed ID for different content returns 409. A completed/cancelled state cannot regress when a late creation event arrives. Conflicting terminal states return 409 and require reconciliation with the authenticated status API; the example never executes payments. Inbox retention requires a separate reviewed policy and is not silently truncated. Signed `test: true` connection probes acknowledge without creating any mirrored transfer.

## Isolated preview

`scripts/startMerchantIntegrationSandbox.cjs` requires an explicit loopback `ahram_company_mobile_demo_*` source URI and a private local configuration file. It copies source documents to its own disposable replica-set database without source writes, skips copied queues/deliveries, builds indexes only in that new database, and seeds isolated receiver endpoints for the demo company/agent. It binds the web app to `127.0.0.1`, disables provider calls/financial schedulers/BullMQ and external messaging, and blocks outbound non-loopback sockets. The original preview remains running.

Only this fixture process adapts `merchant-sandbox.test` to its private HTTPS receiver. The adapter verifies a test certificate and localhost identity over private IPC, without changing the application destination validator or installing a trusted root. Private IPC avoids AVG's substitution of a self-signed certificate during localhost TCP TLS inspection. No antivirus, certificate checks or operating-system trust settings were disabled or changed. Test certificate/key files are public fixtures, never production credentials.

Verified preview: `http://127.0.0.1:4582/client/settings#integrations`. Both API and Webhooks showed ready/available, and a UI connection test returned successful delivery. Its database is disposable; it is not a production migration or a permanently managed database service.

## Validation and limits

- 14 focused regression suites / 113 tests passed, including idempotency debit/ledger rollback, token/IP authorization, ownership, failed-only retries, executor completion outbox, provider settlement/reconciliation, private-probe safety, schema staging and the receiver.
- Additional pressure test passed on the final version: 600 unique transfers (300 company, 300 agent), 1,200 successful replay responses, 600 ledger rows, 1,200 signed Webhook events, 120 lost-acknowledgement retries, 1,200 unique receiver receipts and 600 final mirrored states. No duplicate financial writes or real provider calls occurred.
- Final run: 2,778 HTTP requests including 978 transient conflict responses handled by retries; measured scenario duration 50,077 ms. This is a correctness stress scenario, **not** a production throughput benchmark. Wallet/invoice-counter contention remains a performance consideration; production clients must honor retry guidance and reuse the same idempotency key.
- Terminal notifications were deliberately delivered before creation notifications. The receiver retained every terminal state and applied each mirrored transfer once. Terminal-status updates in the load scenario are synthetic; real-provider execution is disabled. Separate settlement regression tests cover the financial completion paths.
- TLS chain/hostname verification, request HMAC verification and receiver persistence were exercised. This does not establish reachability of a real customer's public receiver or validate a production proxy/worker rollout.

The machine-readable sanitized pressure report is `merchant-webhook-outbox-validation.json`.

## Repository-wide regression run

A full run inspected 304 suites / 2,426 tests: 2,411 passed and 15 failed. Fourteen failure names matched the prior baseline (isolation/provider behavior tests and existing mobile/ledger/owner-email/OTP expectations). One additional source-policy check mistook a generic technical-event `ensureIndexes()` helper name for the notification dedupe index builder; the helper was given an explicit service-specific name, without changing index behavior or weakening that policy test. The index policy/readiness/probe subset then passed all 15 tests. A final receiver test also verifies normal creation → completion → duplicate replay; the combined final receiver/index/readiness/probe check passed 20 tests across four suites. The repository-wide suite is therefore **not claimed green**; the remaining baseline failures are outside this change, and this is not production release approval. The full suite was not rerun after the helper-only rename.
