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
| Error before send | `pending`, executor cleared, zero Payment calls. | Unchanged. |
| Normal success | One Payment, one executor debit (`TRANSFER`, negative amount, description `تنفيذ API آلي`), status `completed`. | Unchanged. |

The customer wallet is still debited when the transfer is created, not when Payment runs. Unresolved rows do not credit that wallet back.

## Fix

Before Payment, the worker claims the row with `findOneAndUpdate` conditioned on `status: processing`, the current executor, no unresolved flag, and no dispatch marker. The claim writes:

- `apiResultData.providerDispatchStartedAt`
- `apiResultData.providerDispatchAttemptId`
- `apiResultData.providerDispatchExecutorGroupId`

The write is committed with majority write concern before the HTTP call. Only the claim winner calls Payment.

A later job that finds a dispatch marker without a definitive result (`accepted`, `rejected`, or `pending_reference`) does not call Payment. It sets:

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
| `routes/adminTransactions.js:682` pull-task | Cannot move the row back to `pending`. |
| `services/mobileWebParityService.js:918` `returnTask` | Cannot move the row back to `pending`. |

A Payment HTTP 200 that is accepted without a reference number is recorded as `providerDispatchResult: pending_reference` (`services/queueService.js:220` and `:247`). That is a definitive result, so it is not flagged unresolved and it is not sent again. The claim itself is `services/externalApiService.js:369`.

Admin global cancel, complaint cancel, executor provider-return cancel, and the mobile executor cancel route all call `reverseTransaction`, so they use that guard.

## Listing

`scripts/listUnresolvedProviderResults.js` is read-only. It uses `countDocuments` and `find` only. It lists flagged rows and `processing` rows that have a dispatch timestamp but no definitive dispatch result.

```bash
MONGO_URI="mongodb://..." node scripts/listUnresolvedProviderResults.js
```

There is no resolution action in this change.

## Resolution is a business decision

The owner has to choose how a human closes an unresolved row. This change does not pick one.

- A provider status query needs a `TransactionNumber`. The crash and timeout paths do not have one, because the Payment response never landed.
- The provider Payment request has no idempotency key, so sending it again can pay again.
- `MachineSerial` is a device serial (`XP1` by default). It does not identify one transfer.

Until that procedure exists, leave the row flagged. Do not refund the customer and do not send Payment again unless the provider has confirmed the first attempt did not pay.

## Migration

New optional fields on the existing mixed `apiResultData` object only. No backfill. No new index. A partial index on `apiResultData.providerResultUnresolved` was considered and not added; unresolved rows should be rare, and an index needs owner approval before it is created.

## Rollback

1. Run `scripts/listUnresolvedProviderResults.js` and keep the output. Flagged rows must be handled manually. Reverting code does not clear the flag and does not refund anyone.
2. Revert the commit. Do not force-push.
3. After revert, the old worker will treat a still-`processing` flagged row as eligible for Payment again. Do not deploy that revert while flagged rows are still `processing` unless an operator has confirmed each one with the provider.
4. No schema migration has to be undone.

## Out of scope

No merge, no deploy, no production database, Redis, provider, or SMTP access, and no real customer messages. Customer debit timing is unchanged. There is no automatic refund, credit, or reversal.
