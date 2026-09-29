# Production boot environment

`assertProductionSecurityEnv()` runs as soon as `app.js` loads. PM2
`env_production` overlays process variables before dotenv, so those flags win
over `.env`. They must match the security policy or production startup exits.

## Required production flags

Set by `config/productionSecurityDefaults.js`, `ecosystem.config.js`
`env_production`, and `scripts/repairProductionEnv.js`:

```ini
NODE_ENV=production
PASSWORD_ONLY_LOGIN_MODE=false
SECURITY_VERIFICATION_ENFORCEMENT_ENABLED=true
SECURITY_VERIFICATION_MODE=required
FORCE_CLIENT_OTP=true
PASSKEY_REQUIRED=false
BYPASS_OTP=false
BYPASS_CLIENT_OTP=false
DISABLE_OTP=false
ENABLE_ENV_ADMIN_LOGIN=false
SECURE_COOKIE=true
SESSION_STORE=mongo
MONGO_TRANSACTIONS_REQUIRED=true
TENANT_ISOLATION_REQUIRED=true
REDIS_ENABLED=true
REDIS_REQUIRED=true
```

Host-specific values belong in the server `.env`, never Git:

- Distinct secrets of at least 32 characters for `JWT_SECRET`,
  `JWT_REFRESH_SECRET`, `SESSION_SECRET`, and `OTP_SECRET`.
- Replica-set `MONGO_URI`, reachable `REDIS_URL` or `REDIS_URI`, tenant ID or
  slug, and HTTPS `PUBLIC_APP_URL`.

## Background subsystem switches

`MERCHANT_WEBHOOK_WORKER_ENABLED`, `EXTERNAL_API_ENABLED`,
`BULLMQ_WORKERS_ENABLED`, and `FINANCIAL_SCHEDULERS_ENABLED` stay on in
production when unset. Only `false`, `0`, `no`, or `off` disables them. Staging
fails closed when unset, and `.env.staging.example` sets all four to false.
Conflicting staging and production mode variables stop startup. See
`docs/operations/staging-isolation.md`.

`MERCHANT_WEBHOOK_STALE_SENDING_RECLAIM_AFTER` is not a kill switch. Leave it
unset until separately approved. Historical `sending` rows are not auto-retried
or backfilled while unset; inspect with
`node scripts/listStaleSendingWebhooks.js`. Delivery is at-least-once; merchants
should deduplicate on `x-ahrampay-event-id`.

## Login OTP: administrator-controlled per account

WhatsApp is never used to deliver a login OTP. Global WhatsApp flags do not
enable or disable this policy. An administrator controls OTP independently for
each account in the admin account editor:

- **OTP off:** after correct credentials, login continues without a code.
- **OTP on:** a valid saved email is required and the code is sent by email
  only (`otpDeliveryChannel=email`).
- **Invalid email or failed email delivery while enabled:** login fails closed;
  there is no WhatsApp fallback.

Clearing the admin checkbox turns OTP off; it does not switch the account to
WhatsApp. `WHATSAPP_LOGIN_OTP_ENABLED` and `LOGIN_OTP_SKIP_WITHOUT_EMAIL` are
retained for compatibility but no longer control login OTP. Use the per-account
admin setting, not those environment variables, to repair an account's login.

`EMAIL_OTP_ENABLED=false` is a server-wide email-delivery kill switch. Accounts
with OTP enabled cannot sign in while that switch is off. Do not use it as a
WhatsApp workaround. Email send failure never falls back to WhatsApp.

`LOGIN_OTP_SKIPPED` audit events record password-only login when account OTP is
disabled. OTP challenge data is cleared before the login continues. Receipt,
cancellation, rate alerts, financial alerts, and support WhatsApp messages are
separate flows and are unaffected.

## Password reset

Password reset is email-only and disabled unless
`PASSWORD_RESET_EMAIL_ENABLED` is `1`, `true`, `yes`, or `on`. It is separate
from login OTP and sends only when `otpDeliveryChannel=email` and a valid saved
email exist. WhatsApp is never a fallback. After code acceptance, the new
password must be submitted within `PASSWORD_RESET_COMPLETE_WINDOW_SECONDS`
(default 600 seconds, clamped to 60–600). Keep reset disabled until the staging
checklist in `docs/operations/password-reset-rollout.md` passes and the owner
approves activation.

## Repair and reload

Review commands before running them on a server:

```powershell
node scripts/repairProductionEnv.js .env
node scripts/auditProductionEnv.js .env
```

The repair command writes only when explicitly invoked with `--apply`. Reload
only after reviewing the environment changes and confirming the intended PM2
target:

```powershell
pm2 reload ecosystem.config.js --env production --update-env
```

Do not copy development-only Redis-optional or password-only values from
`.env.example` to production.

## Device binding

OTP bypass alone does not clear `/login?security=DEVICE_BINDING_MISMATCH`.
Device bindings are per channel; executor app login must not revoke the
executor-portal browser device. If accounts are locked, inspect and revoke only
the affected web device from `/admin/security`. Do not disable device
enforcement broadly without an approved incident procedure. Any emergency
device-binding bypass must be time-limited, documented, and separately approved.
