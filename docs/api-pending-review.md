# Reviewing delayed API operations

Open **مراجعة عمليات API** in the admin sidebar, or `/transactions/operations?providerReview=1`.
The page uses the existing admin account/tenant visibility scope and resolution permissions.
It includes active API operations at least five minutes old, including legacy provider IDs
and incomplete dispatches. Completed/cancelled transactions are excluded.

## Read-only background observation

`apiPendingMonitorService` reads the provider's existing transaction receipt endpoint.
It never calls Payment, completes a transaction, changes a balance, refunds, or queues a payment.
Existing completion workers remain separate. A successful observation requires a masked reference
and matching provider ID, recipient and amount; a contradictory or incomplete receipt needs review.

- Starts one minute after application startup; ticks every minute.
- At most 10 operations per cycle per application process, with sequential requests.
- Each operation has a two-minute database lease so parallel processes cannot check it concurrently.
- Backoff after checks: 5, 10, 20, 30, 60, 120, 120 minutes; stops after the eighth attempt.
- Stops immediately on matching success/return, mismatched receipt, missing provider ID or missing executor.
- Three consecutive failed checks generate an internal admin notification; identical outcomes do not repeat.
- The alert outbox survives restarts and uses deterministic notification IDs to prevent duplicate alerts.
- An admin action that changes the operation during a check invalidates the stale response.
- Only monitoring metadata is written. Customer notes and financial status remain unchanged.

The screen shows whether background observation is enabled. It refreshes the list every 30 seconds;
opening it does not send additional provider requests. The manual **استعلام عن رد جديد** action is
separate and can adopt a verified success through the existing resolution path. Success/cancellation
still require the existing permissions and safeguards. A stopped row remains available for manual review.

## Operational switches

`API_PENDING_MONITOR_ENABLED=false` pauses this worker after restart. It also respects
`FINANCIAL_SCHEDULERS_ENABLED` and `EXTERNAL_API_ENABLED`. Unset defaults follow existing runtime
policy: enabled outside staging, disabled in staging. These switches do not alter stored operations.
No backfill, balance repair, bulk resolution or production data migration is required.

Validation uses an isolated MongoDB test database and mocked provider responses. Production
credentials, receipts and financial records are not used by the tests.
