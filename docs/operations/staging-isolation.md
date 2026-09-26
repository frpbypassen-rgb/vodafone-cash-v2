# Staging isolation and subsystem kill switches

Staging is a separate host: its own MongoDB replica set, its own Redis, local Mailpit with no internet relay, PM2 app `Ahram_QA_Staging`, and a port other than 3000 (the prepared QA process uses 3200). The app treats the process as staging when `NODE_ENV`, `APP_ENV`, or `ENVIRONMENT` is `staging`. `.env.staging.example` sets `NODE_ENV=staging`.

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
| `BULLMQ_WORKERS_ENABLED` | `initBullMQ` does not create queues or workers. Transfer, report, backup, and reconciliation jobs do not run, including their in-process fallbacks. In-app notifications still persist through `Notification.create`. New queue-based API routing is refused up front. |
| `FINANCIAL_SCHEDULERS_ENABLED` | Startup does not run daily settlement or its 15-minute cron, the API completion monitor, the provider-return monitor, or rate-activation timers. Provider-paid rows that are already waiting for local completion stay as they are and are counted in the startup warning. |

## New commitments vs already-sent transactions

A **new commitment** is routing or auto-routing a transfer onto an API executor, or starting web/mobile ZaynPay execution. When that send cannot happen (`EXTERNAL_API_ENABLED` off, or `BULLMQ_WORKERS_ENABLED` off for the queue path), the action is refused with `API_EXECUTION_UNAVAILABLE` before the transfer is assigned or moved to `processing`, before provider HTTP, and before an executor ledger debit. The admin route does not return 200. Auto-route does not log `Auto-route API job queued` and does not apply the API executor. The transfer stays in its prior state. Direct ZaynPay (web and mobile) is blocked only by `EXTERNAL_API_ENABLED`; BullMQ being off does not block that direct path.

Creating a customer transfer request still debits the customer wallet the same way as a pending transfer that is not auto-routed. That debit is the existing request debit, not an executor or provider debit. This change does not refund it, does not change its amount, and does not move it to another account.

An **already-sent** transaction is a `processing` row with `apiResultData.waitingApiAutoCompletion: true`. The provider reference is already stored. While `FINANCIAL_SCHEDULERS_ENABLED` is off:

- the row is not sent to the provider again
- its balance is not refunded or reversed
- Ledger, Transaction, and AuditLog rows are not deleted or rewritten
- startup logs the count, and `node scripts/listProviderPaidAwaitingCompletion.js` prints the same rows read-only

When the switch is turned back on, `startApiCompletionMonitor` uses the existing `completeApiTransaction` path. That path posts the executor ledger debit and marks the row completed only while status is `processing` and `waitingApiAutoCompletion` is true. After that save, a second pass returns without another debit and without a provider call. A crash between the debit and the save is the pre-existing behavior of that function and is not changed here.

Other in-flight provider states (for example a network-pending result that never set `waitingApiAutoCompletion`) are not completed, refunded, or re-sent by this change. Completing them would post a ledger debit the current completion path does not post.

## Merchant webhook backlog

`enqueueTransactionWebhook` upserts on `endpointId` + `eventId` with `$setOnInsert`, so repeating an event does not insert a second delivery row. While the worker is off, `deliverWebhook` returns before `claimDelivery`, so pending rows are not marked `sending` and are not posted. When the worker is enabled again it polls every 30 seconds and claims up to 50 due rows per pass. Delivery is gradual, not one burst of the whole backlog. `claimDelivery` is an atomic update, so a row that is already `sending` is not posted a second time by the next pass.

## In-app notifications

`transfer:created`, `transfer:completed`, and `transfer:cancelled` still call `addNotificationJob`. If BullMQ workers are off, that function writes the in-app `Notification` directly instead of returning without a write. It does not start a new WhatsApp, SMTP, or push send. Those channels keep their existing callers and flags.

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

Reload the previous build. No migration is involved. Outside staging, leaving the four switches unset keeps them enabled. To turn a subsystem back on after an explicit `false`, remove that value or set it to `true` and reload.
