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
that uses login OTP**: retail clients, company staff, agency staff,
agency SubAccounts, and executors. A failed WhatsApp send and a failed
per-account email send (`SMTP_CONFIG_MISSING`, `EMAIL_OTP_SEND_FAILED`,
`EMAIL_OTP_TIMEOUT`, `EMAIL_OTP_ADDRESS_INVALID`) both use this window.
Accounts with no usable email still use WhatsApp for login OTP, unless
`WHATSAPP_LOGIN_OTP_ENABLED` is explicitly off, or
`LOGIN_OTP_SKIP_WITHOUT_EMAIL` is on (see below). A failed email send for an
account that already has a valid address does **not** use the skip flag.

Do **not** set `PASSWORD_ONLY_LOGIN_MODE=true`, `BYPASS_OTP=true`, or
`FORCE_CLIENT_OTP=false` on the live host. Those are rejected by
`assertProductionSecurityEnv()` or permanently weaken production login.

### Exact `.env` steps (max 24 hours)

1. Confirm delivery is the blocker (login page shows a status code such as
   `WHATCHIMP_TIMEOUT`, `WHATCHIMP_CONFIG_MISSING`, `WHATSAPP_PHONE_REQUIRED`,
   `SMTP_CONFIG_MISSING`, or `EMAIL_OTP_SEND_FAILED`). Redis must stay required;
   this bypass does not disable Redis or agency SubAccount privacy.
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

## Login OTP WhatsApp kill-switch

`WHATSAPP_LOGIN_OTP_ENABLED` controls **login OTP on WhatsApp only**. It does
not change `WHATCHIMP_ENABLED`, OTP templates, receipts, rate-change alerts,
or support replies. It also does not change SMTP, `FORCE_CLIENT_OTP`, or
`EMERGENCY_CLIENT_OTP_BYPASS`. Login OTP stays required; only the WhatsApp
send for that OTP stops. Accounts with a valid stored email still receive
login OTP by email.

| Value | Login OTP on WhatsApp |
|---|---|
| unset, or `1` / `true` / `yes` / `on` | Allowed for accounts with no usable email (today's behavior) |
| `0` / `false` / `no` / `off` | Never sent. Login returns `WHATSAPP_LOGIN_OTP_DISABLED` |

Intended production setting while WhatsApp login OTP is paused:

```
WHATSAPP_LOGIN_OTP_ENABLED=false
```

Put it in `.env` (not in PM2 `env_production`), then reload so Node re-reads it:

```powershell
pm2 reload ecosystem.config.js --env production --update-env
```

Accounts with no usable email see an Arabic message that WhatsApp login OTP is
temporarily disabled and that they should use or add email, or contact an
administrator. No WhatsApp send is attempted for that login OTP. If
`LOGIN_OTP_SKIP_WITHOUT_EMAIL=true` as well, those accounts sign in with
username and password instead of seeing `WHATSAPP_LOGIN_OTP_DISABLED`.

To turn WhatsApp login OTP back on later, set `WHATSAPP_LOGIN_OTP_ENABLED=true`
(or remove the line) and run the same `pm2 reload … --update-env`. Do not
toggle `WHATCHIMP_ENABLED` for this.

## Password-only login when no email is stored

الحسابات التي لا يوجد لها بريد صالح تدخل باسم المستخدم وكلمة المرور فقط.
الحسابات التي لها بريد صالح يبقى لها رمز الدخول على البريد.

`LOGIN_OTP_SKIP_WITHOUT_EMAIL` is a non-expiring, production-allowed flag.
`assertProductionSecurityEnv()` accepts it. It is **not** `PASSWORD_ONLY_LOGIN_MODE`,
`BYPASS_OTP`, or `FORCE_CLIENT_OTP=false` — do not set those. Leave this flag
out of PM2 `env_production` so `.env` can turn it on or off without a code change.

It applies to every portal that uses login OTP: retail clients, company staff,
agency staff, agency SubAccounts, executors, and admin accounts.

| Account | Flag on |
|---|---|
| Valid stored email (`email` or `businessProfile.email`) | Login OTP required, sent by email. Unchanged. |
| No usable email | Skip OTP after a correct password. No WhatsApp login OTP is sent. The device is enrolled or rebound the same way `EMERGENCY_CLIENT_OTP_BYPASS` does, so the session guard does not return `/login?security=DEVICE_BINDING_MISMATCH`. |
| Explicit email channel, but the address is missing or invalid | Still fails with `EMAIL_OTP_ADDRESS_INVALID`. Not treated as "no email". |
| Valid email, but the email send fails | Today's error, or the emergency window if that window is active. OTP is not skipped. |

| Value | Effect |
|---|---|
| unset, or `0` / `false` / `no` / `off` | Exactly today's behavior, including `WHATSAPP_LOGIN_OTP_ENABLED` |
| `1` / `true` / `yes` / `on` | No-email accounts skip login OTP |

Each skipped login writes an audit entry `LOGIN_OTP_SKIPPED` with the account,
portal, and `reason: no_email`. While the flag is on, production boot logs:

`[SECURITY WARNING] LOGIN_OTP_SKIP_WITHOUT_EMAIL is active. Accounts without a usable email sign in with username and password only. Accounts with a valid email still require an email OTP.`

`/health` stays `authenticationMode: enhanced-verification` because email
accounts still require OTP and `PASSWORD_ONLY_LOGIN_MODE` stays `false`.
`WHATCHIMP_ENABLED`, receipts, rate alerts, support replies, and SMTP are unchanged.

### Turn on

In the host `.env` (not `ecosystem.config.js`):

```
LOGIN_OTP_SKIP_WITHOUT_EMAIL=true
```

`WHATSAPP_LOGIN_OTP_ENABLED=false` can stay set. No-email accounts will not
attempt a WhatsApp login OTP.

Then restart the production process so Node re-reads `.env`:

```powershell
pm2 restart Ahram_Core_API --update-env
```

### Turn off

Set the flag to false (or remove the line) and restart again:

```
LOGIN_OTP_SKIP_WITHOUT_EMAIL=false
```

```powershell
pm2 restart Ahram_Core_API --update-env
```

With the flag off, accounts that have no usable email follow
`WHATSAPP_LOGIN_OTP_ENABLED` again (WhatsApp OTP, or
`WHATSAPP_LOGIN_OTP_DISABLED` when that kill-switch is off).

## Documented break-glass (device-binding mismatch)

OTP bypass alone does **not** clear `/login?security=DEVICE_BINDING_MISMATCH`.
After a verified password + OTP (or OTP emergency bypass), the portal now
enrolls the first device and rebinds the current browser when a stale device
record would otherwise soft-lock the business. Suspicious transfers still
create an admin notification in the security center.

Web and mobile bindings are **per channel**: logging into the executor app must
not revoke the executor-portal browser device. If production still has the
legacy `uniq_active_security_device_per_account` index, a normal deploy that
runs `ensureSecurityDeviceIndexes` restores `uniq_active_security_device_per_channel`.

### Immediate unblock without waiting on a full feature deploy

1. Ask the user to sign out and sign in again with password + WhatsApp OTP from
   the browser they need. Verified login rebinds that channel only.
2. From `/admin/security`, revoke the stuck principal's web device (or both
   channels if the account is compromised), then have them log in again.
3. Disable **account device enforcement** temporarily from `/admin/security` if
   many companies are locked (re-enable once devices are rebound).
4. If a live session still bounces after pull/reload, use a **separate** 24h
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
that Redis stays required. That health value stays `enhanced-verification`
when `LOGIN_OTP_SKIP_WITHOUT_EMAIL=true`. Do **not** set
`PASSWORD_ONLY_LOGIN_MODE=true`, `BYPASS_OTP=true`, or `REDIS_REQUIRED=false`.

Related financial break-glass (unchanged):

- `EMERGENCY_STANDALONE_FINANCIAL_WRITES=true` with the matching expiry and reason

`ENABLE_ENV_ADMIN_LOGIN` stays false. Do not use `PANEL_USER` / `PANEL_PASS` for normal production login.

Staging (`NODE_ENV=staging`, `.env.staging.example`) may remain password-only for sandbox testing.
