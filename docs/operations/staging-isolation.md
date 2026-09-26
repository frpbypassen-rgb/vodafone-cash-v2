# Staging isolation and subsystem kill switches

Staging is a separate host: its own MongoDB replica set, its own Redis, local Mailpit with no internet relay, PM2 app `Ahram_QA_Staging`, and a port other than 3000 (the prepared QA process uses 3200). The app treats the process as staging when `NODE_ENV`, `APP_ENV`, or `ENVIRONMENT` is `staging`. `.env.staging.example` sets `NODE_ENV=staging`.

## IMPORTANT DEPLOY PREREQUISITE

These four switches are **off when unset**. Only `1`, `true`, `yes`, or `on` enable them (same parsing as `PASSWORD_RESET_EMAIL_ENABLED`).

```
MERCHANT_WEBHOOK_WORKER_ENABLED=true
EXTERNAL_API_ENABLED=true
BULLMQ_WORKERS_ENABLED=true
FINANCIAL_SCHEDULERS_ENABLED=true
```

Production must set all four to `true` before this build is reloaded. Leaving them unset stops:

- merchant webhook delivery (the 30s worker and every direct HTTP delivery)
- outbound calls to ZaynPay and other financial API providers
- BullMQ workers, queue processors, and their in-process fallbacks
- financial schedulers: daily settlement, API completion polling, provider-return reconciliation, and rate-activation timers

Startup writes one warning that lists the switches that are off.

## What each switch does

| Switch | Off behavior |
| --- | --- |
| `MERCHANT_WEBHOOK_WORKER_ENABLED` | `startMerchantWebhookWorker` does not start. `deliverWebhook` returns before it claims a delivery or calls HTTP, including the immediate dispatch from `enqueueTransactionWebhook`. |
| `EXTERNAL_API_ENABLED` | `executeTransferViaApi`, preflight, balance, transaction review, and `zaynpayApi` login/inquiry/pay return or throw `EXTERNAL_API_DISABLED` before any provider HTTP. |
| `BULLMQ_WORKERS_ENABLED` | `initBullMQ` does not create queues or workers. `addTransferJob`, `addNotificationJob`, `addReportJob`, `addBackupJob`, and `addReconciliationJob` do not run the in-process fallback. |
| `FINANCIAL_SCHEDULERS_ENABLED` | Startup does not run daily settlement or its 15-minute cron, the API completion monitor, the provider-return monitor, or rate-activation timers. |

`EXTERNAL_API_ENABLED=false` reuses the existing provider-failure result (`success: false`). The transfer queue then returns the transaction to `pending` and clears the API executor assignment. It does not post a ledger entry and does not mark the transaction completed or failed. ZaynPay web and mobile execution return an error before any balance or ledger write. Provider reconciliation gets an empty result, so it does not mark transactions returned or completed.

When BullMQ workers are off, a transfer that the router already set to `processing` stays `processing` because the job is not consumed. That does not move balances. An operator can pull the task. Turning the workers back on does not by itself replay jobs that were never queued.

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

Set the four production switches to `true` and reload the previous build. No migration is involved. While the switches are off, do not expect webhooks, provider execution, queues, or automatic settlement to run.
