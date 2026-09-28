# Unresolved provider Payment results

Two defects in the immediate API execution path could pay the provider more than once or return a transfer to the assignable pool after Payment may already have been accepted.

Customer debit timing is unchanged. This fix does not add an automatic refund, credit, or reversal.

## Conditions

### Defect 1 — crash after provider acceptance

`executeTransferViaApi` sends `POST /api/V1/Transactions/Payment`. The executor debit and `tx.save()` happen only after that call returns. If the process stops after Payment succeeded and before that save, the row stays `processing` with no stored result. A later job used to call Payment again and debit the executor again.

### Defect 2 — ambiguous transport result

Timeout, `ECONNRESET`, and HTTP 5xx after Payment was sent used to be returned as `{ success: false }`. The queue worker then set `pending`, cleared the executor, and wrote a failure note. The row re-entered the assignable pool even though the provider may have paid. A later route could send Payment again, and cancel-with-refund could credit the customer.

Errors before the Payment request is sent still use that old failure path: DNS failure, connection refused, validation, inquiry failure, and inquiry/gate refusal.

If it is not clear whether Payment was sent, the result is unresolved.

## Financial impact

| Situation | Before | After |
| --- | --- | --- |
| Crash after Payment, before save | Second Payment and a second executor debit. Customer debit from creation stays held. | One Payment. At most one executor debit. Row stays `processing` and flagged, or `completed` if the success save landed. No second debit. No customer refund. |
| Timeout, reset, or HTTP 5xx after send | Row returns to `pending`. A new route can pay again. Cancel-with-refund credits the customer while the provider may have paid. | One Payment. Zero executor debits. Zero customer refunds or credits. Status stays `processing`, executor stays assigned, row is flagged. |
| HTTP 200 accepted, no reference (`pending_reference`) | Row returned to `pending` and could be refunded or sent again. | Same money hold as an unresolved result: stay `processing`, keep the executor, flag `providerResultUnresolved`, no refund, no second Payment. |
| Error before send | `pending`, executor cleared, zero Payment calls. | Unchanged. |
| Normal success | One Payment, one executor debit (`TRANSFER`, negative amount, description `تنفيذ API آلي`), status `completed`. | Unchanged. |

The customer wallet is still debited when the transfer is created, not when Payment runs. Unresolved rows do not credit that wallet back.

## Fix

Before Payment, the worker claims the row with `findOneAndUpdate` conditioned on `status: processing`, the current executor, no unresolved flag, and no dispatch marker. The claim writes:

- `apiResultData.providerDispatchStartedAt`
- `apiResultData.providerDispatchAttemptId`
- `apiResultData.providerDispatchExecutorGroupId`

The write is committed with majority write concern before the HTTP call. Only the claim winner calls Payment.

A later job that finds a dispatch marker without a settled result (`accepted` or `rejected`) does not call Payment. `pending_reference` is not settled. The job sets:

- `apiResultData.providerResultUnresolved = true`
- `apiResultData.providerResultUnresolvedAt`
- `apiResultData.providerResultUnresolvedReason`
- `apiResultData.providerResultUnresolvedCode = PROVIDER_RESULT_UNRESOLVED`

and appends an admin note. Status stays `processing`. The executor stays assigned. There is no executor debit, no customer refund or credit, and no return to `pending`.

A definitive provider rejection, or a transport error that failed before send, releases the claim so today's `pending` retry behavior remains.

## Guards

Automatic re-send and human cancel-with-refund are refused while a row is flagged or still has an in-flight marker without a definitive result.

| Path | Behavior |
| --- | --- |
| `services/queueService.js:54` `addJob`, `:70` `processSingleJob`, `:99` `processSingleJobSerialized` | Do not call Payment. In-flight rows are flagged. Failure (`:254`) and exception (`:277`) handlers do not return those rows to `pending`. An unresolved provider result returns at `:157` with no executor debit and no `tx.save()`. |
| `services/bullQueueService.js:71` worker and `:168` `addTransferJob` | BullMQ retries (`attempts: 3`) hit the same guard and return without Payment. |
| `services/autoRouteService.js:286` `enqueueAutoRouteIfNeeded` | Does not publish a new task or enqueue Payment. |
| `services/apiExecutionLifecycleService.js:266` `completeApiTransaction`, `:375` `completeDueApiTransactions` | The delayed-completion sweeper does not debit a flagged or in-flight row. |
| `services/apiProviderReconciliationService.js:285` `syncProviderReturnedOperations` | Skips flagged and in-flight rows, so the return monitor does not offer them for refund. |
| `services/reconciliationService.js:176` `_performIntegrityChecks` | Counts unresolved rows. It does not change them. |
| `src/Application/Services/ReversalService.ts:504` `reverseTransaction` (fallback preview at `:356`) | Cancel-with-refund returns `409` / `PROVIDER_RESULT_UNRESOLVED`. |
| `src/Application/Services/TransferService.ts:789` `cancelTransfer` | Same refusal before any wallet credit. |
| `controllers/executorTransactionController.js:306` `postCancelTask` and `:357` `postReturnTask` | Direct refund and return-to-pending are refused. |
| `routes/adminTransactions.js` pull-task, assign-executor, and global-cancel | Cannot pull, reassign, or cancel-with-refund a held row. |
| `services/mobileWebParityService.js:918` `returnTask` | Cannot move the row back to `pending`. |

A Payment HTTP 200 that is accepted without a reference number is recorded as `providerDispatchResult: pending_reference` and `providerResultUnresolved: true` (`holdProviderAcceptedWithoutReference` in `services/queueService.js`). Status stays `processing` and the executor stays assigned. The claim itself is `services/externalApiService.js:369`.

`pending_reference` reuses `providerResultUnresolved` instead of a second flag. Every refund, return-to-pending, pull, assign, auto-route, and queue guard already keys off that hold. A second flag would be one missed `if` away from refunding a transfer the provider may have accepted. Operators still tell the cases apart: `providerDispatchResult` is `pending_reference` for an HTTP 200 without a reference, and it is empty for a timeout, reset, 5xx, or crash. No new index is added.

Admin global cancel, complaint cancel, executor provider-return cancel, and the mobile executor cancel route all call `reverseTransaction`, so they use that guard.

## Listing

`scripts/listUnresolvedProviderResults.js` is read-only. It uses `countDocuments` and `find` only. It lists flagged rows and `processing` rows that have a dispatch timestamp but no definitive dispatch result.

```bash
MONGO_URI="mongodb://..." node scripts/listUnresolvedProviderResults.js
```

There is no resolution action in this change.

## Resolution procedure

Close one flagged row only after the provider has given evidence. The provider status API cannot do this by itself: it needs a `TransactionNumber`, the crash and timeout paths do not have one, Payment has no idempotency key, and `MachineSerial` is a device serial (`XP1` by default).

Permission: `transactions.resolve_provider`. Routing staff with only `transactions.manage` cannot close these rows. A master admin can. The permission is not granted to accountants.

1. Get evidence from the provider: a TransactionNumber, a statement line, or a ticket id, plus a short note of what it shows.
2. Dry-run. This changes nothing and does not call Payment.

```bash
MONGO_URI="mongodb://..." node scripts/resolveUnresolvedProviderResult.js \
  --id "<transaction id>" \
  --outcome provider_paid \
  --evidence "<provider reference>" \
  --note "<what the evidence shows>" \
  --actor-id "<admin id>"
```

The same dry-run is `POST /transaction/:id/resolve-provider-result` with `{ outcome, evidenceReference, note, confirm: false }`.

3. Read the preview. `provider_paid` shows one executor debit (`ExecutorGroup`, amount `-transaction.amount`, type `TRANSFER`, description `تنفيذ API آلي`) and zero customer refund. `provider_not_paid` shows zero money movements. The row will return to `pending` through `releaseFailedApiExecutionToPending`, the same release the queue already uses when Payment is known to have failed before it was sent. A customer refund is not posted here. After the row is pending, an operator can cancel it with the existing reversal screen if the customer should be credited.
4. Confirm with the same outcome, evidence, note, and `expectedUpdatedAt` from the preview. Add `--confirm --expected-updated-at "<preview expectedUpdatedAt>"` on the script, or `"confirm": true` on the endpoint.
5. If the response is `ROW_CHANGED`, someone else touched the row. Dry-run again. Do not confirm the old preview.
6. Check the audit log action `PROVIDER_RESULT_RESOLVED`. It stores the actor, the evidence, and the before/after snapshot.

`provider_paid` completes the row through `completeApiTransactionWithReference`. That posts at most one executor debit and never calls Payment. A second confirm does not debit again. `provider_not_paid` does not credit the customer and does not call Payment.

Refuse the action when evidence or the note is blank.

## Migration

New optional fields on the existing mixed `apiResultData` object only (`providerResolutionOutcome`, `providerResolutionEvidence`, `providerResolutionNote`, `providerResolutionActorId`, `providerResolutionClaimedAt`, `providerResolutionEffectStartedAt`, `providerResolvedAt`). No backfill. No new index. A partial index on `apiResultData.providerResultUnresolved` was considered and not added; unresolved rows should be rare, and an index needs owner approval before it is created.

## Rollback

1. Run `scripts/listUnresolvedProviderResults.js` and keep the output. Flagged rows must be handled manually. Reverting code does not clear the flag and does not refund anyone.
2. Revert the commit. Do not force-push.
3. After revert, the old worker will treat a still-`processing` flagged row as eligible for Payment again. Do not deploy that revert while flagged rows are still `processing` unless an operator has confirmed each one with the provider.
4. No schema migration has to be undone.

## Out of scope

No merge, no deploy, no production database, Redis, provider, or SMTP access, and no real customer messages. Customer debit timing is unchanged. There is no automatic refund, credit, or reversal.
