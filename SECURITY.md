# Security report — Al-Ahram Pay

This document describes **implemented** controls. It is not a certification and does not claim live OFAC/UN/EU AML feeds.

## Credential rotation (public git history)

Seed and reset scripts previously contained real-looking passwords, phones, and tokens (including values such as `MyKids0124` and `ZAYNPAY_API_GROUP_TOKEN`). Those files now use generated demo placeholders only.

If this repository was ever public or cloned with the old history, **operators must rotate out of band**:

- Admin panel passwords (`PANEL_USER` / `PANEL_PASS`)
- Merchant API keys (company `token` / agent `apiToken`) — issue new keys from the admin UI
- Provider credentials (`ZAYN_PASSWORD`, executor `apiPassword` / `apiToken`)
- JWT / session / OTP / encryption / API-key pepper / device-hash secrets
- Telegram and WhatsApp tokens

Do not put real secrets in git. Copy `.env.example` locally and set values on the server only.

## 1. Encryption and hashing at rest

| Data | Storage | Key |
|---|---|---|
| User / admin passwords | bcrypt (12 rounds) | N/A (one-way) |
| Merchant API keys (`ClientCompany.tokenHash`, `User.apiTokenHash`, tenant `apiKeyHash`) | HMAC-SHA256 | `API_KEY_PEPPER` (plaintext returned **once** at create/rotate) |
| Provider passwords / static tokens that must be replayed to an external API (`ExecutorGroup.apiPassword`, `apiToken`) | AES-256-GCM | `ENCRYPTION_KEY` (64 hex chars). Never derived from `JWT_SECRET`. |
| Webhook secrets / TOTP secrets | AES-256-GCM | `ENCRYPTION_KEY` |
| Device identifiers | HMAC-SHA256 | `SECURITY_DEVICE_HASH_SECRET` (dedicated; not `SESSION_SECRET`) |

Staging and production refuse to boot or encrypt without the purpose-specific secrets above. Local `NODE_ENV=development` / `test` may use clearly labeled local fallbacks.

Run `npm run migrate:secrets` with `ENCRYPTION_KEY` and `CONFIRM_DB_NAME` to hash leftover plaintext merchant keys and encrypt provider secrets. Merchant keys that lived in plaintext **must still be rotated**.

## 2. Idempotency / replay protection

Mobile transfers and `POST /api/v1/merchant/transfer` require a UUID `Idempotency-Key`. Matching fingerprint replays the stored response; a conflicting payload returns `409 IDEMPOTENCY_CONFLICT`. Merchant transfers also use per-merchant rate limiting (15/min) and audit logging. Balance debit remains atomic with `$gte`.

## 3. Audit trail

Sensitive admin and financial actions are written to append-only audit logs (no delete/update API). Merchant API transfers log `TRANSFER_CREATED`.

## 4. Rate limiting

- Global limiter (stricter in production)
- Login limiters
- Mobile and merchant transfer limiters (15/min)

## 5. Authentication

Web sessions use Mongo-backed cookies (`httpOnly`, `secure` in production, `SameSite`). Mobile APIs use short-lived access tokens and rotating refresh tokens. Production requires enhanced login verification (`PASSWORD_ONLY_LOGIN_MODE=false`, `SECURITY_VERIFICATION_ENFORCEMENT_ENABLED=true`, `SECURITY_VERIFICATION_MODE=required`, `FORCE_CLIENT_OTP=true`) plus Redis (`REDIS_REQUIRED=true`).

## 6. Device trust, fraud, AML

- Device-trust middleware **fails closed** on transfer routes when verification is required and the lookup errors.
- `createTransfer` treats only `req.isDeviceTrusted === true` as trusted; `undefined` is untrusted.
- Velocity freeze updates the user by `_id`, not phone.
- `AmlSanctionsService` is a **DEMO stub** with an `ISanctionsProvider` interface. It is **not** a live OFAC/UN/EU integration. Do not describe it as production sanctions screening until a licensed provider is wired.

## 7. HTTP hardening

- Global JSON/urlencoded body limit is `256kb`. Authenticated upload/Base64 routes (mobile API, executor portal, deposit proof) may use up to `40mb`.
- CSP still allows `'unsafe-inline'` because EJS views embed inline scripts; adding a nonce would disable `'unsafe-inline'` in modern browsers and break those pages. Residual XSS risk remains until templates are nonced.
- `/api-docs` is off in production unless `ENABLE_API_DOCS=true`, and then requires an admin session.

## 8. Destructive scripts

`reset.js` and `scripts/factoryReset.js` never run in production. They also require `ALLOW_FINANCIAL_RESET=true` and `CONFIRM_DB_NAME` matching the connected database. `DRY_RUN=true` prints counts only. Seed scripts refuse `NODE_ENV=production`.
