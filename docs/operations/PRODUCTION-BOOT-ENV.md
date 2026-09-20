# Production boot environment

`assertProductionSecurityEnv()` runs as soon as `app.js` loads. PM2
`env_production` overlays process variables **before** dotenv, so those
flags win over `.env`. They must match the security policy or
`pm2 reload ecosystem.config.js --env production` exits with
`Unsafe production configuration`.

## Required production flags

Set by `config/productionSecurityDefaults.js`, applied by both
`ecosystem.config.js` `env_production` and `scripts/repairProductionEnv.js`:

```
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

Host-specific (must exist in `.env`, never commit real values):

- Distinct ≥32-character `JWT_SECRET`, `JWT_REFRESH_SECRET`, `SESSION_SECRET`, `OTP_SECRET`
- Real replica-set `MONGO_URI` (not `demo`)
- Reachable `REDIS_URL` or `REDIS_URI`
- `DEFAULT_TENANT_SLUG` or `DEFAULT_TENANT_ID`
- `PUBLIC_APP_URL` on HTTPS

## Repair then reload

```powershell
node scripts/repairProductionEnv.js .env
node scripts/repairProductionEnv.js .env --apply
node scripts/auditProductionEnv.js .env
pm2 reload ecosystem.config.js --env production --update-env
```

`.env.example` keeps password-only Redis-optional values for
`NODE_ENV=development` only. Do not copy those onto the live host.

## Documented break-glass (OTP provider outage)

Leave these **out of PM2** `env_production` so a time-limited `.env` window still
works. The flag name says `CLIENT`, but the code applies it to **every portal
that uses WhatsApp login OTP**: retail clients, company staff, agency staff,
agency SubAccounts, and executors.

Do **not** set `PASSWORD_ONLY_LOGIN_MODE=true`, `BYPASS_OTP=true`, or
`FORCE_CLIENT_OTP=false` on the live host. Those are rejected by
`assertProductionSecurityEnv()` or permanently weaken production login.

### Exact `.env` steps (max 24 hours)

1. Confirm WhatChimp is the blocker (login page shows a WhatsApp status code
   such as `WHATCHIMP_TIMEOUT`, `WHATCHIMP_CONFIG_MISSING`, or
   `WHATSAPP_PHONE_REQUIRED`). Redis must stay required; this bypass does not
   disable Redis or agency SubAccount privacy.
2. Edit **only** `.env` (not `ecosystem.config.js`):

```
EMERGENCY_CLIENT_OTP_BYPASS=true
EMERGENCY_CLIENT_OTP_BYPASS_EXPIRES_AT=2026-09-21T12:00:00Z
EMERGENCY_CLIENT_OTP_BYPASS_REASON=WhatChimp OTP delivery outage
```

`EMERGENCY_CLIENT_OTP_BYPASS_EXPIRES_AT` must be a valid ISO timestamp **no
more than 24 hours in the future**. The reason is required while the window
is active.

3. Reload so Node re-reads `.env`. PM2 must **not** pin the emergency keys:

```powershell
pm2 reload ecosystem.config.js --env production --update-env
```

4. Users sign in with username + password. WhatsApp OTP is skipped until
   expiry. The first verified device is enrolled so the session guard does
   not bounce them back to `/login?security=DEVICE_BINDING_MISMATCH`.
5. When WhatChimp is healthy, remove the three `EMERGENCY_CLIENT_OTP_BYPASS*`
   lines (or set the flag to `false`) and reload again.

Boot still warns: `Emergency client OTP bypass is active until …`.

## Documented break-glass (device-binding mismatch)

OTP bypass alone does **not** clear `/login?security=DEVICE_BINDING_MISMATCH`.
After a verified password + OTP (or OTP emergency bypass), the portal now
enrolls the first device and rebinds the current browser when a stale device
record would otherwise soft-lock the business. Suspicious transfers still
create an admin notification in the security center.

If a live session still bounces after pull/reload, use a **separate** 24h
window. Leave these **out of PM2** `env_production`:

```
EMERGENCY_DEVICE_BINDING_BYPASS=true
EMERGENCY_DEVICE_BINDING_BYPASS_EXPIRES_AT=2026-09-21T12:00:00Z
EMERGENCY_DEVICE_BINDING_BYPASS_REASON=DEVICE_BINDING_MISMATCH portal lockout
```

Then `pm2 reload ecosystem.config.js --env production --update-env`.

Remove the three lines when the window ends.

## Administrator: pull and restart (production outage)

On the live host, as the service user, from the application directory:

```powershell
git fetch origin main
git pull origin main
node scripts/auditProductionEnv.js .env
pm2 reload ecosystem.config.js --env production --update-env
pm2 logs Ahram_Core_API --lines 80
```

Confirm `/health` returns `authenticationMode: enhanced-verification` and
that Redis stays required. Do **not** set `PASSWORD_ONLY_LOGIN_MODE=true`,
`BYPASS_OTP=true`, or `REDIS_REQUIRED=false`.

Related financial break-glass (unchanged):

- `EMERGENCY_STANDALONE_FINANCIAL_WRITES=true` with the matching expiry and reason

`ENABLE_ENV_ADMIN_LOGIN` stays false. Do not use `PANEL_USER` / `PANEL_PASS` for normal production login.

Staging (`NODE_ENV=staging`, `.env.staging.example`) may remain password-only for sandbox testing.
