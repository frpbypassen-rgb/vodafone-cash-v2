# Merchant integration reliability

Applies to company and agency owners. No production deployment, proxy change, worker handoff or real financial transfer is part of this change.

## Transfer idempotency contract

`POST /api/v1/merchant/transfer` accepts optional `Idempotency-Key` (1–128 ASCII letters, digits, `.`, `_`, `:`, `-`). Use a new random key for each intended transfer and retain the same key and payload when retrying an uncertain response. Requests without the header retain their existing behavior; they do not acquire this replay guarantee.

The key is hashed with account model, account ID and tenant. The normalized recipient, amount, service, receipt number and bank code form the request fingerprint. The original successful response is saved in the same MongoDB transaction as the debit, ledger and transfer. A replay returns that response and `Idempotency-Replayed: true`, without another debit, ledger entry or routing call. The response describes the original acceptance; use the status endpoint for current execution status.

- `400 IDEMPOTENCY_KEY_INVALID`: invalid key syntax.
- `409 IDEMPOTENCY_CONFLICT`: same scoped key, different payload. Do not generate another key to work around an uncertain original transfer.
- `409 IDEMPOTENCY_IN_PROGRESS`: concurrent/uncertain commit; retry the same key after `Retry-After` (2 seconds) or query status.
- Existing `429` cooldowns can still apply to new requests.
- `503 FINANCIAL_TRANSACTIONS_UNAVAILABLE`: transactions unavailable. New keyed requests fail before financial writes.
- `503 IDEMPOTENCY_INDEX_UNAVAILABLE`: a read-only index check could not confirm the existing single-field unique `Transaction.idempotencyKey` index. No index is built by the request.

MongoDB replica-set/sharded transactions and the unique index are required. Do not build or alter an index on production financial data without a separate reviewed migration and duplicate audit. Replay continues to require a currently valid token and current IP/admin permissions, including after token rotation. Records are retained with their transactions; deleting them removes the replay guarantee. Never reuse a key for a new transfer.

This guarantees one committed financial operation for a retained key, not exactly-once external delivery. Existing post-commit event/routing notifications remain best effort; a committed response can be replayed after a notification error without redispatch. Durable downstream recovery remains a separate concern.

## Webhook retry protection

Both administrative and owner retry routes atomically claim only `failed` deliveries below the attempt budget. Delivered, pending, in-flight and exhausted deliveries return `409 DELIVERY_NOT_RETRYABLE`. Attempt counts are preserved. Account/tenant visibility filters remain mandatory. Concurrent manual retries yield at most one claim; this does not change the inherent at-least-once Webhook contract. Receivers must deduplicate event IDs.

Editing the destination URL or rotating its secret clears that endpoint's prior delivery health, so an old success cannot confirm a changed destination.

## Read-only readiness and UI

`GET /client/api/integrations/overview` and the agency equivalent are owner/tenant scoped. They expose administrative access separately from token/IP, Mongo transaction/index capability, endpoint setup, transport availability and observed delivery health. No readiness request creates a transfer, sends a test Webhook, reveals credentials or changes settings.

The summary presents two columns on desktop and one on mobile, with token/IP state, endpoint counts and last success/failure. Failures retain clearly marked previous data and the last successful check. Management links stay visible but disabled with a reason; a 401/403 clears private summary data. Polling pauses outside the panel and backs off on errors. Email/Telegram settings initialize only when their own panel opens in either portal.

## Technical diagnostics

`MerchantIntegrationEvent` accepts only fixed codes, operations, normalized IP, HTTP status, timestamps and counts. It stores no tokens, request bodies, credentials or receiver responses. Repeats aggregate into five-minute buckets, reads return at most ten entries, and expiry is seven days (also filtered on reads). Writes are best effort, concurrency bounded and time limited; diagnostic failure must not block a financial request. TTL/lookup indexes are initialized only by normal background initialization, never the private probe role.

## Validation

Focused tests cover real isolated replica-set debit/ledger atomicity, concurrent replay, account isolation, payload conflicts, insufficient funds, response-storage rollback, post-commit notification errors, current token/IP authorization, missing unique index, failed-only Webhook claims, owner/tenant boundaries, sanitized diagnostics, read-only summaries, stale/recovery UI and lazy panel initialization. All financial test data is disposable and isolated from the demo/live databases.

Browser checks cover desktop/mobile layouts, readiness and stale/recovery states. Synthetic fixtures exercise successful/error delivery metadata without contacting an external receiver. The local demo deliberately disables Webhook transport and uses standalone MongoDB, so its readiness warning is expected; it does not validate a production receiver or establish production transaction/index readiness.

Final focused run: **17 suites, 156 tests passed**, including private-probe and financial tenant safety regressions. Architecture policy and lint for the changed integration/lazy-loading modules passed. Browser widths 320/390 and 1366 were checked without horizontal overflow; the real company page showed readiness results and email/Telegram requests started when opening notifications. Intermittent local overview timeouts were observed despite fast HTTP completion logs; stale state and subsequent successful recovery were verified, but the underlying intermittent transport behavior was not attributed to a specific cause. These results are not a full-repository or production acceptance test.
