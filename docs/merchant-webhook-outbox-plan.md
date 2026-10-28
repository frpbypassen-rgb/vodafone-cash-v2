# Atomic merchant webhook outbox and isolated load testing

Scope: local branch and a disposable replica-set demo only. Do not change production processes, balances, provider integrations, proxies or the existing standalone demo database.

1. Embed bounded lifecycle event slots in each business transfer document. Mongoose save and single-document status updates stage an immutable event snapshot in the same write/session. Financial rollback also removes the event. Exclude deposits/internal accounting types; do not backfill historic transfers implicitly.
2. Dispatch pending slots after commit through the existing owner/tenant-scoped Webhook endpoint selection and unique delivery key. Acknowledge only after deliveries are durably staged; repeated dispatch must not resend delivered events. Keep legacy event listeners as a fallback only for records without durable slots. No network I/O from a financial transaction.
3. Require an explicit reviewed outbox index migration before a worker scans financial data. Local fixtures create indexes in their disposable database. Preserve admin gates, HTTPS/private-address restrictions, retry budgets and worker switches.
4. Provide an example receiver with raw-body HMAC/timestamp verification, persistent transactional deduplication, per-transfer state progression and rejection of conflicting terminal states. Supply no shared production secret.
5. Start an isolated replica-set preview copied from the existing demo, preserving that source database. Use a pinned local HTTPS receiver only through a local test transport adapter; never weaken public destination validation or TLS verification.
6. Run many synthetic merchant API requests, duplicate/concurrent requests, crashes/rollbacks, failures/retries, revoked-token/IP gates and out-of-order receiver events. Count wallet debits, ledger rows, transfers, staged events and receiver applications. Report exact load and results, and keep real external transfers disabled.

Completed locally. See `merchant-webhook-outbox.md` and `merchant-webhook-outbox-validation.json` for implementation boundaries, migration prerequisites, the isolated preview, test counts and the measured contention limitation. Production was not changed.

Follow-up completed on 2026-10-28: bounded driver transaction retries reduced the same stress scenario's client-visible conflicts from 978 to zero; scoped queue age/count diagnostics, operational gauges and throttled lag warnings were added; the fourteen prior regression failures were repaired. Final verification passed all 305 suites / 2,438 tests. See the follow-up and regression validation JSON reports. No production rollout was performed.
