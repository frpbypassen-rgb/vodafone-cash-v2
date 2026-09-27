# Staging isolation and subsystem kill switches

Staging is a separate host: its own MongoDB replica set, its own Redis, local Mailpit with no internet relay, PM2 app `Ahram_QA_Staging`, and a port other than 3000 (the prepared QA process uses 3200). `.env.staging.example` sets `NODE_ENV=staging`.

## How staging is detected

`isStagingRuntime` in `utils/runtimeControls.js` is true when any non-empty value among `NODE_ENV`, `APP_ENV`, and `ENVIRONMENT` is `staging` (compared after trim and lower-case). An empty or unset variable is ignored. Consistent values do not conflict: all three `staging`, or only `NODE_ENV=staging` with the others unset, is staging. All three `production`, or `NODE_ENV=production` with the others unset, is not staging.

`stagingEnvConflict` is true when at least one of those three is `staging` and another is a non-empty value other than `staging`. Two conflict examples:

- `NODE_ENV=production` and `APP_ENV=staging` (ENVIRONMENT unset)
- `NODE_ENV=staging` and `APP_ENV=production` (ENVIRONMENT unset)

On a conflict the process is still treated as staging for switch defaults, so an unset switch stays off. It also refuses to start. `collectStagingEnvViolations` adds `STAGING_ENV_CONFLICT`, and `assertStagingStartupSafe` throws `STAGING_STARTUP_REFUSED` before listen (`app.js` exits 1). A production box therefore cannot keep serving with the switches silently off, and a staging box cannot be treated as production. `scripts/checkStagingReadiness.js` reports the same violation as a FAIL. Set all three to the same mode, or leave `APP_ENV` and `ENVIRONMENT` unset, before starting.

## Switch defaults

The four switches are `MERCHANT_WEBHOOK_WORKER_ENABLED`, `EXTERNAL_API_ENABLED`, `BULLMQ_WORKERS_ENABLED`, and `FINANCIAL_SCHEDULERS_ENABLED`.

Outside staging, an **unset** switch is **enabled**. Production keeps today's webhooks, provider calls, queues, and financial schedulers without adding `=true` lines. Only an explicit `false`, `0`, `no`, or `off` disables a switch.

In staging, an **unset** switch is **disabled**. `.env.staging.example` also sets all four to `false`. Only `1`, `true`, `yes`, or `on` enables one. The staging startup guard and `scripts/checkStagingReadiness.js` still refuse real provider, webhook, and SMTP addresses.

Startup logs one warning that lists whichever switches are off.

## What each switch does when it is off

| Switch | Off behavior |
| --- | --- |
| `MERCHANT_WEBHOOK_WORKER_ENABLED` | `startMerchantWebhookWorker` does not start. `deliverWebhook` returns before it claims a delivery or calls HTTP. Pending delivery rows stay pending. |
| `EXTERNAL_API_ENABLED` | No outbound call to ZaynPay or another financial provider. New API routing, API auto-route, and web/mobile ZaynPay execution are refused before any provider send and before any new executor ledger debit. |
| `BULLMQ_WORKERS_ENABLED` | `initBullMQ` does not create queues or workers. Transfer, report, backup, and reconciliation jobs do not run, including their in-process fallbacks. In-app notifications still persist. A notification with no explicit event key is a plain insert, the same as before. Transfer notifications pass an explicit key and upsert on that key. New queue-based API routing is refused up front. Queued jobs are not deleted. |
| `FINANCIAL_SCHEDULERS_ENABLED` | Startup does not run daily settlement or its 15-minute cron, the API completion monitor, the provider-return monitor, or rate-activation timers. Provider-paid rows that are already waiting for local completion stay as they are and are counted in the startup warning. |

## New commitments vs already-sent transactions

A **new commitment** is routing or auto-routing a transfer onto an API executor, or starting web/mobile ZaynPay execution. When that send cannot happen (`EXTERNAL_API_ENABLED` off, or `BULLMQ_WORKERS_ENABLED` off for the queue path), the action is refused with `API_EXECUTION_UNAVAILABLE` before the transfer is assigned or moved to `processing`, before provider HTTP, and before an executor ledger debit. The admin route does not return 200. Auto-route does not log `Auto-route API job queued` and does not apply the API executor. The transfer stays in its prior state. Direct ZaynPay (web and mobile) is blocked only by `EXTERNAL_API_ENABLED`; BullMQ being off does not block that direct path.

## Customer debit, then routing, then executor debit

The switches do not change the customer-wallet debit. That debit still happens while the transfer request is created, before routing and before any provider call. Its amount, account, and timing stay the same with the switches unset or set to `false`.

Web and mobile client creation (`controllers/clientTransactionController.js`):

1. Customer wallet debit and its ledger row, still inside request creation: sub-account `SubAccount.findOneAndUpdate` then `new Ledger` at lines 357-374, master wallet at 378-396, or the client/company/agent wallet at 434-453.
2. The `Transaction` is inserted as `pending` at line 457.
3. Routing is applied after that debit: `applyAutoRouteFields` at line 471, then `enqueueAutoRouteIfNeeded` at line 505 after commit. An API auto-route is refused before those fields change when execution cannot run.

Merchant API creation (`routes/merchantApi.js`):

1. Customer or agent wallet debit: `MerchantModel.findOneAndUpdate` `$inc: { balance: -costLYD }` at line 319, inside the same database transaction as the request.
2. Routing fields: `applyAutoRouteFields` at line 369, still before the ledger insert.
3. `Transaction.create` at line 370, then the customer `Ledger` at line 375 (`entityModel` User or ClientBot, `type` TRANSFER, `amount` `-costLYD`).
4. `enqueueAutoRouteIfNeeded` at line 394, after commit.

Admin routing (`routes/adminTransactions.js` `POST /transaction/:id/assign-executor`, starting at line 558) does not debit the customer again. The customer was already debited at creation. For an API executor, `apiQueueExecutionBlock()` at line 578 returns 409 `API_EXECUTION_UNAVAILABLE` before the status update at line 601, so the row is not moved to `processing` and no executor is stored. A human executor can still be assigned.

Executor ledger debit happens only after a successful provider result, or when a provider-paid waiting row is completed:

- Immediate API success: `completeApiTransactionWithReference` calls `updateBalanceWithLedger` with `-tx.amount`, entity `ExecutorGroup`, type `TRANSFER`, description `تنفيذ API آلي` (`services/apiExecutionLifecycleService.js` lines 179-186).
- Delayed completion of `waitingApiAutoCompletion`: `completeApiTransaction` claims the row at lines 315-324, then calls `updateBalanceWithLedger` with `-claimed.amount` on that same `ExecutorGroup` (lines 330-337).
- Web ZaynPay posts the executor group `$inc` only after `zaynpay.pay` succeeds (`controllers/executorTransactionController.js` lines 669-703). Mobile ZaynPay posts `ledgerInc` inside the success session after `zaynpay.pay` (`services/mobileWebParityService.js` lines 1017-1057). The balance read before pay does not debit.

What the switches prevent: a new API assignment, the provider HTTP call, and therefore the executor ledger debit that only follows that call. While `FINANCIAL_SCHEDULERS_ENABLED` is off they also prevent the delayed completion debit of an already provider-paid row. What they do not change: the customer-wallet debit at request creation (same account, same amount, same moment, before routing). Nothing in this change refunds that debit.

The delayed executor debit, the waiting-flag update, and the completion save commit in one MongoDB transaction (`completeApiTransaction`, `session.withTransaction`). `updateBalanceWithLedger` receives that same session, so the debit amount, account, type, and description are unchanged. A second concurrent call does not match the waiting row, so it does not post a second ledger row and does not call the provider. If the debit throws, or the process stops before commit, the transaction rolls back: `waitingApiAutoCompletion` stays true, no executor ledger row remains, and a later pass can post that same debit once. There is no automatic refund.

An **already-sent** transaction is a `processing` row with `apiResultData.waitingApiAutoCompletion: true`. The provider reference is already stored. While `FINANCIAL_SCHEDULERS_ENABLED` is off:

- the row is not sent to the provider again
- its balance is not refunded or reversed
- Ledger, Transaction, and AuditLog rows are not deleted or rewritten
- startup logs the count, and `node scripts/listProviderPaidAwaitingCompletion.js` prints the same rows read-only

When the switch is turned back on, `startApiCompletionMonitor` uses `completeApiTransaction`. The atomic claim above posts the executor ledger debit once and then marks the row completed. A second pass returns `completion_already_claimed` or `not_waiting_api_completion` without another debit and without a provider call. There is no automatic refund.

Other in-flight provider states (for example a network-pending result that never set `waitingApiAutoCompletion`) are not completed, refunded, or re-sent by this change. Completing them would post a ledger debit the current completion path does not post.

## Merchant webhook delivery

The 50-per-30-seconds figure is a poll batch size, not a dedupe guarantee.

`enqueueTransactionWebhook` builds `eventId` as `` `${transaction._id}:${eventType}:${transaction.status}` `` and upserts `MerchantWebhookDelivery` on `endpointId` + `eventId` with `$setOnInsert` (`services/merchantWebhookService.js`). Repeating the same event does not insert a second row. The JSON body is still `buildPayload`: a new `id` (UUID), `type`, `created_at`, and `data`. That body is not an idempotency key.

`claimDelivery` is `findOneAndUpdate`. It matches a `pending` or `failed` row whose `nextAttemptAt` is due and whose `attemptCount` is below 6, or a `sending` row whose `lockedAt` is older than `LOCK_TIMEOUT_MS` (2 minutes). The update sets `status: 'sending'`, sets `lockedAt`, and increments `attemptCount`. `deliverWebhook` returns before this claim when the worker switch is off.

`processPendingWebhooks` selects only `pending` and `failed` (limit 50, every 30 seconds from `startMerchantWebhookWorker`). It does not select `sending`. After a 2xx response the row is set to `delivered`. A non-2xx or a thrown error sets `failed`, clears `lockedAt`, and sets `nextAttemptAt` from `RETRY_DELAYS_MS`: 60 seconds, 5 minutes, 30 minutes, 2 hours, 6 hours, then 24 hours. After 6 attempts `nextAttemptAt` is null and the row is not retried.

The HTTP headers are `content-type`, `user-agent`, `x-ahrampay-event` (the event type), `x-ahrampay-event-id` (the stored `eventId`), `x-ahrampay-delivery` (the delivery `_id`), `x-ahrampay-timestamp`, and `x-ahrampay-signature`. `x-ahrampay-event-id` is the stable idempotency key. It is not added to the JSON body.

Honest limit: delivery is at-least-once when a failure is recorded, and at-most-once for a hard crash that never records the result.

- If the success write throws after the merchant returned HTTP 2xx, the catch marks the row `failed`. The next poll does not send it again until `nextAttemptAt`. After that delay it sends the same body again with the same `x-ahrampay-event-id`. The merchant must dedupe on that header.
- If the process dies after the merchant received the request and before the success write, the row stays `sending` with a fresh `lockedAt`. The next poll does not select `sending`, so it does not redeliver. `claimDelivery` would reclaim that row only when `deliverWebhook` is called after `lockedAt` is older than 2 minutes. The poller never does that.

This exclusion is already on main (`dd152b76`). `processPendingWebhooks` there selects only `pending` and `failed` at `services/merchantWebhookService.js` lines 201-206. `claimDelivery` on that commit (lines 96-106) can match a stale `sending` row, but the poller never loads those rows, so it never calls `deliverWebhook` for them. This PR does not change that query. `node scripts/countIsolationBacklog.js` reports `webhookSending` and, separately, `webhookSendingStale` (`status: 'sending'` and `lockedAt` older than 2 minutes).

While the worker is off, `deliverWebhook` returns before `claimDelivery`, so pending rows are not marked `sending` and are not posted. Re-enabling the worker drains `pending` and due `failed` rows gradually, 50 per 30 seconds, not as one burst.

## In-app notifications

`transfer:created`, `transfer:completed`, and `transfer:cancelled` still call `addNotificationJob`. Those three call sites pass an explicit key `` `${transactionId}:${recipientId}:${type}` ``, using `customId` or `_id` as the transaction id. `recordInAppNotification` upserts on that key only (`services/bullQueueService.js`). Documents without the field are ordinary inserts.

`models/Notification.js` does not declare `{ dedupeKey: 1 }` unique sparse. `config/database.js` sets `autoIndex` false. Nothing in startup, `syncIndexes`, `ensureIndexes`, `createIndexes`, or a migration runner creates `notifications.dedupeKey_1`. `Notification.syncIndexes()` would drop that index if it had been created by hand, because it is not part of the schema. Do not call it after the manual step below.

In-app notification delivery is not exactly-once.

Without the unique index:

- Sequential calls with the same explicit key keep one row. The second `updateOne` upsert matches the first document and `$setOnInsert` does not insert again.
- True concurrency does not. Two overlapping upserts of a key that is not there yet can both insert. Duplicate notification rows are possible. No wallet, ledger, or transfer amount changes. On a `MongoMemoryReplSet`, 8 rounds of 24 overlapping upserts of one new key produced row counts 3, 2, 3, 4, 2, 2, 2, and 2. A later run can differ. The test requires the largest of those 8 counts to be greater than 1.

With `notifications.dedupeKey_1` created by the manual script, the second overlapping insert fails with duplicate key `11000` or `11001` and `recordInAppNotification` ignores that error, so those concurrent calls keep one row. That is still not exactly-once delivery: BullMQ, a process restart, or a caller with no key can still produce another row or another job. A caller that does not pass a key gets `Notification.create` and a BullMQ job with no `jobId`. Two identical texts for the same user stay two rows and two jobs. BullMQ does not drop the second job.

If workers are off, `addNotificationJob` writes the in-app row directly and does not enqueue. It does not delete jobs already in Redis. A later worker run of a transfer job carries the same explicit key. Sequential execution of that direct row and that queued job does not create two notifications. Overlapping execution can, until the unique index exists. This does not start a new WhatsApp, SMTP, or push send.

Owner-approved manual step, not part of deploy: `node scripts/checkNotificationDedupeDuplicates.js` is aggregate-only. It prints how many notifications have a `dedupeKey`, how many duplicate key groups exist, and sample ids. It does not write. Then, only after that report shows zero duplicate groups, `node scripts/createNotificationDedupeIndex.js --confirm-create-notification-dedupe-index` creates `dedupeKey_1` and no other index. Both scripts abort on the production PM2 name `ahram_core_api`, the production app path, or a denied production database name (`vodafone_cash_system`, `vodafone_cash`). The create script also aborts when the confirmation flag is missing or any duplicate group exists. Do not run the create script except from that explicit command or from tests.

## ZaynPay URL fallback

Production still uses `https://zaynpay.com` from `utils/apiProviderPresets.js` when the executor `apiUrl`, `ZAYN_AGGREGATOR_URL`, and `ZAYNPAY_URL` are all empty. That fallback is unchanged outside staging.

In staging the preset is not used. An unset URL, or any host that is not loopback (`localhost`, `127.0.0.1`, `::1`) and not listed in `STAGING_SANDBOX_HOST_ALLOWLIST`, is refused before HTTP (`PROVIDER_URL_REFUSED`). Creating an API executor on staging without an explicit URL stores a blank `apiUrl` instead of `https://zaynpay.com`.

## Staging startup guard

When staging mode is on, the process exits 1 before it listens if any of these are true:

- `SMTP_HOST` is set and is not `localhost`, `127.0.0.1`, or `::1` (empty SMTP is allowed: no relay)
- `ZAYN_AGGREGATOR_URL`, `ZAYNPAY_URL`, or `ZAYN_EXECUTOR_API_URL` is set to a non-sandbox host
- a stored executor `apiUrl` (`executorgroups` or legacy `executorbots`) or merchant webhook `url` is a non-sandbox host (read-only query)
- PM2 `name`, `PM2_NAME`, `PM2_APP_NAME`, or the process title is `Ahram_Core_API`
- `PORT` is `3000` or unset
- `MONGO_URI` has no database name, or the name is `vodafone_cash_system`, `vodafone_cash`, or another name denied by `STAGING_CHECK_DENY_DBS`

`scripts/checkStagingReadiness.js` applies the same port, SMTP relay, provider URL, and stored-URL checks. It already refused the production PM2 name and the production database names.

Local Mailpit (`SMTP_HOST=127.0.0.1`) with no provider URLs and no webhook URLs is accepted.

## Rollback

Re-enabling a worker or scheduler, or reloading the previous build, starts that subsystem immediately. It will process whatever backlog is already waiting. Count that backlog with read-only commands before removing an explicit `false` or reverting the build. Do not delete queued jobs, delivery rows, or transactions as part of this rollback.

Read-only Mongo counts (`node scripts/countIsolationBacklog.js`, or the same filters in a shell). The script only calls `countDocuments`:

- `providerPaidAwaitingCompletion`: `transactions` where `status` is `processing` and `apiResultData.waitingApiAutoCompletion` is true
- `webhookPending`, `webhookFailed`, `webhookSending`: `merchantwebhookdeliveries` by `status`
- `webhookSendingStale`: `sending` rows whose `lockedAt` is older than 2 minutes. The poller selects a stale `sending` row only when `MERCHANT_WEBHOOK_STALE_SENDING_RECLAIM_AFTER` is a valid ISO time and `lockedAt` is after that time. When the variable is unset, or the lock is at or before the cutoff, the row is not selected. List those ids with `node scripts/listStaleSendingWebhooks.js` (counts and delivery ids only). That listing does not send.

Read-only BullMQ counts, one queue at a time, with no worker and no `obliterate`, `drain`, or `remove`: `api-transfers-queue`, `notifications-queue`, `reports-queue`, `backups-queue`, `reconciliations-queue`. Use `Queue.getJobCounts()` and then `queue.close()`.

Also count processing API transfers that are not yet provider-paid (an upper bound is `transactions` with `status: 'processing'` and `apiResultData.waitingApiAutoCompletion` not true). The BullMQ `api-transfers-queue` count is the set a worker will actually pick up.

What each re-enable does to that backlog:

- `EXTERNAL_API_ENABLED`: does not by itself walk the backlog. It allows provider calls. Turn this on before BullMQ workers if queued transfer jobs must succeed. If workers start while this is still off, `executeTransferViaApi` fails closed and `queueService` moves those processing rows back to `pending` and clears the executor. That is a status change, not a customer refund.
- `BULLMQ_WORKERS_ENABLED`: workers start and process queued jobs immediately. `api-transfers-queue` jobs call the provider when external API is on, and a successful reference posts the executor ledger debit. Transfer notification jobs upsert on their explicit event key. Jobs with no key insert a new in-app row. Report, backup, and reconciliation jobs run their existing work.
- `FINANCIAL_SCHEDULERS_ENABLED`: the API completion monitor completes due provider-paid waiting rows and posts each executor ledger debit once. It does not re-send the provider call and does not refund. Rows that are not `waitingApiAutoCompletion` are not completed.
- `MERCHANT_WEBHOOK_WORKER_ENABLED`: each 30 seconds, up to 50 due `pending` or `failed` deliveries are claimed and posted. A stale `sending` row (lock older than 2 minutes) is included only when its `lockedAt` is after `MERCHANT_WEBHOOK_STALE_SENDING_RECLAIM_AFTER`. Historical stuck rows are not auto-retried. Delivery is at-least-once. Merchants dedupe on `x-ahrampay-event-id`.

`notifications.dedupeKey_1` is not created by deploy or startup. The owner-approved manual step is `node scripts/checkNotificationDedupeDuplicates.js`, then `node scripts/createNotificationDedupeIndex.js --confirm-create-notification-dedupe-index` only when the pre-check reports zero duplicate groups. Both refuse the production PM2 name, the production app path, and the denied production database names. See In-app notifications above. Do not run `Notification.syncIndexes()` afterwards; it would drop an index that is not on the schema.

Recommended order, after the counts look acceptable: enable `EXTERNAL_API_ENABLED`, then `BULLMQ_WORKERS_ENABLED`, then `FINANCIAL_SCHEDULERS_ENABLED`, then `MERCHANT_WEBHOOK_WORKER_ENABLED`. Outside staging, removing an explicit `false` (or leaving the variable unset) is what turns a switch back on. Reloading the previous build starts every subsystem at once and processes the same backlogs immediately, so count before that revert as well. No migration is involved. The customer-wallet debit from request creation is not reversed by re-enabling any switch.

## Mongo transaction in completeApiTransaction

`completeApiTransaction` (`services/apiExecutionLifecycleService.js`) is the delayed provider-paid path. `session.withTransaction` starts at line 388. The callback commits only database writes. A `TransientTransactionError` or write conflict retries that callback. Receipt files and `eventBus.publish` run after `session.endSession()` (lines 451 and 453).

1. Saved inside the callback:

- Claim, lines 391-400: `Transaction.findOneAndUpdate` matches `status: 'processing'`, the same `executorGroupId`, and `apiResultData.waitingApiAutoCompletion: true`. It sets `apiResultData.waitingApiAutoCompletion` to false and `apiResultData.completionClaimedAt` to the current date. If no document matches, the callback returns without a debit.
- Executor ledger debit, lines 403-411, through `walletService.updateBalanceWithLedger` with that same session (`services/walletService.js` lines 95-96, so this session is not committed inside the wallet helper). The helper debits `ExecutorGroup.balance` by `-claimed.amount` (lines 65-68) and inserts one `Ledger` row (lines 78-89): `entityModel: 'ExecutorGroup'`, `type: 'TRANSFER'`, `amount: -claimed.amount`, `transactionId: claimed.customId`, `description: 'تنفيذ API آلي'`.
- Transaction fields on `claimed.save({ session })`, lines 413-424: `status: 'completed'`, `executorName: 'تنفيذ آلي (API)'`, `completedAt`, `adminNotes` (the delayed-completion note), and `apiResultData` copied forward with `waitingApiAutoCompletion: false`, `completedAt`, and `executorReceiptProof` left as already stored or null. `proofImage` and `proofImages` are not written here.

2. No provider HTTP, WhatsApp, webhook enqueue, `eventBus.publish`, receipt send, or BullMQ `add` runs inside the callback, directly or through `updateBalanceWithLedger`, model hooks, or `eventBus` listeners. `walletService.js` does not publish or call HTTP. `Ledger` and `Transaction` have no hooks that do. The receipt file (`createApiExecutorReceiptProof` / `saveProofImage` / `attachApiReceiptProofs`) is `attachCompletionReceiptAfterCommit` at lines 103-167, called at line 451, after commit. The proof update is `Transaction.updateOne` and matches only when `apiResultData.executorReceiptProof` is missing or null, so a second pass does not write another file. `eventBus.publish('transfer:completed')` is line 453, after that update. Listeners on the real bus (merchant webhook enqueue, in-app notification, WhatsApp receipt) therefore run after commit as well. A database rollback cannot cancel a transfer the provider already paid, because this function does not call the provider.

3. The immediate path is `queueService.processSingleJobSerialized`. `services/queueService.js` has no diff against main `dd152b76`. This PR did not put that path inside a Mongo transaction. `executeTransferViaApi` is line 97, before any completion write. The provider `Payment` POST is `services/externalApiService.js` line 417, outside any `withTransaction`. This PR only added the external-API and provider-URL gates in front of that call. After a reference comes back, `completeApiTransactionWithReference` (`services/apiExecutionLifecycleService.js` lines 246-253) debits the executor with `updateBalanceWithLedger` and no external session, so `walletService.js` lines 100-107 commit that debit before `queueService.js` line 141 `tx.save()`. The provider call is not inside that debit transaction either.

A hard crash after the provider has accepted the transfer and after that debit has committed, but before line 141, leaves the row `status: 'processing'` with `waitingApiAutoCompletion` not true and one executor `TRANSFER` ledger already stored. The in-memory `completed` fields are lost. The catch at `queueService.js` lines 196-208 would move the row to `pending` and clear the executor, but a hard kill does not run it. The next `processSingleJob` still sees `processing` (lines 59-68) and calls `executeTransferViaApi` again (line 97), which can post a second executor debit. That retry behavior is pre-existing on main `dd152b76`. This PR does not change it. `listProviderPaidAwaitingCompletion` does not list the stuck row, because that filter requires `waitingApiAutoCompletion: true`. Read-only detection is a `transactions` find of `status: 'processing'` whose waiting flag is not true, plus a `ledgers` find on that `customId`. There is no customer refund on that path.

## Known limits

Webhook delivery is at-least-once. A recorded failure is sent again after `nextAttemptAt`, with the same `x-ahrampay-event-id`. The merchant dedupes on that header. A row left `sending` by a hard crash is selected by `processPendingWebhooks` only when `MERCHANT_WEBHOOK_STALE_SENDING_RECLAIM_AFTER` is a valid ISO time and `lockedAt` is after that time and older than 2 minutes. When the variable is unset, the poller still selects only due `pending` and `failed` rows, which is the behavior on `6cc6d02b`. Historical stuck rows are listed by `node scripts/listStaleSendingWebhooks.js` and are not auto-retried. `node scripts/countIsolationBacklog.js` still reports `webhookSending` and `webhookSendingStale`.

The immediate provider path can also send the same transfer again and debit the executor again after a hard crash between provider acceptance and `tx.save()`, as described above. That is pre-existing on main `dd152b76` (`services/queueService.js` lines 97 and 141). This PR does not change that sequence and does not add a refund.

## Unresolved provider result

When the connection drops after the provider may have accepted a transfer (timeout, socket reset, HTTP 5xx after the payment request was sent, or a crash after accept), the required rule is: do not automatically send that payment again, and do not automatically refund or credit the customer or the executor. Resolve the row only with a reliable provider status query or a provider-supported idempotency key. Without one of those, the row belongs in manual review and a read-only listing. This PR does not implement that hold. The immediate path is unchanged from main `dd152b76`.

The immediate API path has one provider client, `executeTransferViaApi` in `services/externalApiService.js`. Both presets in `utils/apiProviderPresets.js` (`zayn_external_aggregator` and `zaynpay_legacy`) use that same client. The payment body (`externalApiService.js` lines 409-416; main `dd152b76` lines 363-370) is `Fields`, `CurrentServiceProviderId`, `ServiceId`, `PaymentBillInfo`, `Amount`, and `MachineSerial`. `MachineSerial` is the shared device serial (`XP1` in the preset). It is not a per-transfer idempotency key. No idempotency key is sent or stored for this call.

A status-query endpoint exists and is not used on this path. `getApiProviderTransactions` posts `/api/V1/Transactions/Print` with `{ TransactionNumber }` (`externalApiService.js` lines 542-545; main `dd152b76` lines 488-491). It can review a transfer only when a provider transaction number is already known. `apiProviderReconciliationService.js` calls it at line 298 for stored provider ids. The payment timeout path never receives a `TransactionNumber`, and `executeTransferViaApi` does not call Print.

On main `dd152b76`, a timeout, `ECONNRESET`, or HTTP 5xx thrown by the Payment request is caught at `externalApiService.js` lines 432-435 and returned as `{ success: false }`. The same catch is `externalApiService.js` lines 478-481 on this branch. The function does not retry Payment and does not call Print. `queueService.processSingleJobSerialized` (unchanged from main, lines 186-194) treats that as a definite failure: `status` becomes `pending`, `executorGroupId` and `executorName` are cleared, and the admin note is `[فشل التنفيذ الآلي: ...]`. It does not debit the executor, does not refund the customer, and does not call Payment again in that attempt. A second `processSingleJob` then stops at lines 59-68 because `status` is no longer `processing`, so that retry does not send again. BullMQ `attempts: 3` (`services/bullQueueService.js` line 162) does not replay this outcome either, because the worker returns normally. `listProviderPaidAwaitingCompletion` does not list the row. There is no manual-review flag and no read-only listing for it. The row is back in the assignable `pending` pool, so a later new assignment can send it again. That classification is pre-existing on main. This PR does not change it.

The web ZaynPay button is a second client of the same Payment URL, not the queue worker. `services/zaynpayApi.js` `pay` (lines 143-147) posts Payment and, on HTTP 401 or body `Code` 401, posts Payment a second time. Its catch (lines 164-169) returns `{ success: false }` for other thrown errors, including timeout and 5xx. `controllers/executorTransactionController.js` lines 671-672 return that error and do not debit or refund. This PR only added the outbound gate in front of `pay`. It does not change the 401 retry or the catch.

A hard crash after a successful Payment response and before `tx.save()` is the separate case in the Mongo transaction section above: the row stays `processing` and a later job sends again. That is also pre-existing.

## Proposed fix (not applied)

Do not apply this in PR #80. It changes the immediate execution path, which this PR did not introduce.

In `executeTransferViaApi`, set `paymentDispatched = true` immediately before the Payment `axios.post` (`externalApiService.js` line 417). In the catch at lines 478-481, if `paymentDispatched` is true, return `{ success: 'unresolved', code: 'PROVIDER_RESULT_UNRESOLVED', message, processLog }` and do not post Payment or Print again. If the error is thrown before that flag (token, inquiry, or configuration), keep today's `{ success: false }`.

In `queueService.processSingleJobSerialized`, before line 97, return without calling the provider when `tx.apiResultData.providerResultUnresolved === true`. On `apiResult.success === 'unresolved'`, keep `status: 'processing'`, keep `executorGroupId`, set `apiResultData.providerResultUnresolved` and `providerResultUnresolvedAt`, append an admin note that the provider result is unresolved, and save. Do not call `updateBalanceWithLedger`. Do not credit the customer or the executor.

Add a read-only count and listing (`countDocuments` / `find` + `lean` only) for `apiResultData.providerResultUnresolved: true`. Do not complete, refund, or re-send those rows from a scheduler.

Risks: the customer creation debit stays in place until a person resolves the row, which is intentional. The executor is not debited, so a payment the provider did accept is missing from the executor ledger until that review. Leaving `status: 'processing'` without the skip above would make the next job call Payment again (lines 59-68). A human cancellation that refunds `processing` rows must exclude this flag, or the cancel becomes an automatic refund. Print still cannot answer these rows, because no `TransactionNumber` was stored. A timeout can also mean the provider never received the request; holding the row is the conservative choice.

Tests to add after approval, on `MongoMemoryReplSet`: timeout, `ECONNRESET`, and HTTP 500 after Payment each produce one Payment call, zero Print calls, zero ledger rows, and an unchanged customer balance; the row stays `processing` with the flag set; a second `processSingleJob` does not call Payment. An inquiry timeout, before Payment, still follows today's `pending` failure path and posts zero Payment calls. A normal Payment success still debits the executor once.
