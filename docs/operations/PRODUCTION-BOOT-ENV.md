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

## Documented break-glass

Leave these **out of PM2** so a time-limited `.env` window still works:

- `EMERGENCY_CLIENT_OTP_BYPASS=true` plus ISO `EMERGENCY_CLIENT_OTP_BYPASS_EXPIRES_AT` (max 24h) and `EMERGENCY_CLIENT_OTP_BYPASS_REASON`
- `EMERGENCY_STANDALONE_FINANCIAL_WRITES=true` with the matching expiry and reason

`ENABLE_ENV_ADMIN_LOGIN` stays false. Do not use `PANEL_USER` / `PANEL_PASS` for normal production login.

Staging (`NODE_ENV=staging`, `.env.staging.example`) may remain password-only for sandbox testing.
