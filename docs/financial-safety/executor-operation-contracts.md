# Executor operation contracts

Scope: executor portal improvements on `codex/executor-financial-safety`, based on the local checkout after PR #109. These contracts document behavior preserved during service extraction, not a promise that production has been validated.

## Authorization boundary

- Every portal read and write reloads the employee. Employee and group must be active, and the stored session version must match.
- Managers alone can change employee accounts, pools, routing, and company deposit requests. Accountants cannot accept, edit, cancel, return, complete, or dispatch payment tasks.
- Task mutations retain accepted-state and employee ownership filters. Proof retries and task annotations retain executor/manager group ownership checks.
- Existing global CSRF and tenant middleware remain outside this router. No exemption or permission is added by this extraction.

## HTTP and financial contracts

All paths below are under `/executor-portal/api`; existing request fields and success payloads are preserved.

| Operation | Path / fields | Required invariant |
| --- | --- | --- |
| Accept | `POST accept-task/:id` | Atomic routing claim; no second active task or repeated acceptance movement. |
| Edit | `POST edit-amount/:id`, `newAmount`, `reason` | Existing transfer-pricing function and exchange-rate rules; cost difference and customer balance change commit together. |
| Cancel | `POST cancel-task/:id`, `reason` | Required reason; only the owning accepted task can change to rejected; refund and rejection commit together, once. |
| Return | `POST return-task/:id`, `reason` | Accepted/owned state transition to pending clears routing; no new customer debit or refund. |
| Complete | `POST complete-task/:id`, existing sender/proof fields | Existing proof policy and receipt references; completion save retains the accepted/owned guard; amount, cost, commission, and pricing are not recalculated. |
| Provider | `POST zaynpay-execute/:id` | Existing provider permission and runtime switches; durable claim before payment; uncertain results block retry/refund; group ledger changes commit with local completion. |

Expected validation, ownership, and unresolved-provider responses keep their existing statuses and public codes. Legacy endpoints that return HTTP 200 with `success: false` retain that contract. `FINANCIAL_TRANSACTIONS_UNAVAILABLE` fails closed with HTTP 503.

Intentional error-handling changes:

- Unexpected exceptions return generic public text. Internal exception text is not returned, appended to cancellation notes, or logged by the new portal error boundary.
- Support-domain validation errors retain their status/message. Unexpected support faults now return HTTP 500 instead of exposing an exception as a validation error.
- Failure of executor-balance reconciliation, audit delivery, event publication, cancellation receipt/notification, or lock release after a committed operation is logged without falsely reporting a failed financial operation. Reconciliation updates stored executor balance totals; a failed reconciliation can leave those totals stale. This extraction does not add an outbox, retry worker, or guarantee downstream delivery.
- The general proof list remains limited to five images and eight MiB per image; existing split-sender proof rules remain separate. Encoded input is bounded before decoding, and validation avoids a whole-payload capture regex that could overflow the JavaScript stack on large uploads. A malformed generated receipt stops manual completion, or holds a provider-paid operation for reconciliation. Image content/signature validation is not added here.

## Service ownership

- `executorTransactionController`: request/response adaptation and compatible exports.
- `executorTransactionMutationService`: amount edits, cancellation/refund, and return transitions.
- `executorCompletionService`: manual/bank completion, proof policy, and post-save side effects.
- `executorProviderExecutionService`: provider claim, payment, local settlement, and uncertainty hold.
- `executorProofStorageService`: upload bounds and local proof storage.
- `executorCancellationNotificationService`: post-refund receipt and notification delivery.
- `executorSupportController` / `executorSupportService`: legacy support handlers / structured support-domain errors.

## Evidence and release gates

`executorFinancialMongo.test.js` exercises real local Mongo transactions: duplicate funding, rollback, competing requests, provider settlement/hold, amount edits, and one-time cancellation refunds. Provider replies are synthetic; no live payments are performed.

`executorWebTransactionController.test.js`, `executorPortalErrorBoundary.test.js`, and `executorProofStorageService.test.js` exercise ownership, revoked/inactive sessions, role boundaries, proof limits, secret containment, and post-save failures.

`pnpm run check:executor-readiness -- <env-file>` is a read-only Mongo preflight. It probes a snapshot read and inspects the live TrustedDevice TTL index. It does not register models, synchronize indexes, change records, or migrate a legacy index. Use approved deployment credentials and environment; passing it alone is not production certification.

Before deployment: validate the final commit in CI on Node 20/22, build Docker, verify server settings and PDF rendering, run the read-only database preflight, review any index migration separately, and verify backup/rollback procedures. None of these should be inferred from local test counts.
