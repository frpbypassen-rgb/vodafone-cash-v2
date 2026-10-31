# Security baseline review — 2026-11-01

Scope: repository review and local tests, plus read-only HTTPS/header checks on
ahrampay.com. No production restart, credential migration, balance change,
transaction update, provider request or financial queue action was performed.

Assets and boundaries: credentials and MFA proofs enter the login routes;
sessions and tenant/account identifiers control access to private financial
records and receipts; merchant requests and callbacks cross external boundaries.
Abuse cases checked here include structured credential injection, credential
guessing hidden behind HTTP 200 form responses, private data in error messages,
untrusted CORS origins, and accidental secret-file publication.

## Controls and evidence

| Requested control | Status and limits |
| --- | --- |
| Password hashing | Account save hooks use bcrypt cost 12; legacy login migration exists. This does not prove all production records are hashed. Use the optional read-only counter below before planning any migration. No passwords were reset. |
| Environment secrets | `.env` was already ignored; added all `.env.*` overrides and private key/certificate containers, preserving example templates. Existing tracked files are not removed by `.gitignore`; the tracked PEM files found are test-only receiver fixtures. No history-wide secret audit or rotation was performed. |
| HTTPS | Public `/login` responded over certificate-validated HTTPS. HSTS is present. IIS owns TLS termination; no binding, redirect or certificate settings changed. |
| Database injection | This application uses MongoDB/Mongoose, not SQL. Parameterized SQL is not applicable to the reviewed runtime. Added scalar type, length and NUL checks for unified-login credential aliases before normalization/lookup; object/array operators are rejected. This is not an audit of every database call in the repository. |
| CAPTCHA | Pending provider selection and privately configured keys. Do not claim CAPTCHA is active or introduce a challenge without matching server-side verification. Turnstile, if selected, requires single-use server verification plus expected hostname/action checks: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/ |
| CORS | Existing explicit origins retained; regression tests deny unrelated browser origins and preserve server-to-server API calls without Origin. CORS is not an authorization mechanism. Review `ALLOWED_ORIGINS` on production separately. |
| Security headers | Public HSTS, CSP, frame protection, nosniff and referrer policy verified. Helmet's unsupported `permissionsPolicy` option did not emit a header; replaced with explicit Permissions-Policy restricted to self. Camera/microphone remain available for proof capture and executor voice attachments; geolocation remains available for login. Existing inline-script allowances in CSP require a separate nonce migration and UI regression pass. |
| Directory listing | Express serves the `public` root using static middleware, with no directory-index middleware. IIS/Plesk directory browsing outside the application has not been inspected in this review. |
| Dependencies | Updated scoped glob dependencies of swagger-jsdoc and rimraf to 14.0.3. No forced remediation or dependency lifecycle hooks run. Production audit: 7 moderate findings before, 0 after. Complete development-inclusive audit still reports 28 moderate and 3 low findings in the test/lint toolchain; do not downgrade Jest/ESLint to npm's suggested incompatible versions. Revisit by 2026-11-08 with upstream-compatible fixes; keep untrusted patterns out of the test/lint toolchain in the meantime. |
| Errors | Global fallback no longer logs raw messages/stacks or request bodies; it logs numeric status only, preserves valid 4xx status, disables error caching and delegates errors after headers were sent. Route-local error handlers remain a separate audit surface. |
| Output encoding | Reviewed retail views escape HTML and escape `<` in inline JSON; retail scripts render untrusted values as text. No global HTML stripping added: validation and context-specific encoding must preserve legitimate financial/customer data. No claim of a repository-wide XSS audit. |
| Rate limiting | Fixed unified-login failures bypassing the limit because rendered error pages return HTTP 200. All attempts now count toward 10/minute/IP, including MFA posts. Validated proxy/IP normalization remains unchanged. Current limiter uses process memory; multiple production processes would require a shared store. Users sharing one NAT address share this limit. |
| Private user data | Existing owner/tenant-scoped reports and receipt proxies preserved; generic errors tested. At-rest database/backup encryption, retention and hosting access controls need separate infrastructure evidence. |
| Before release | Existing production environment validator retained. CI now blocks moderate-or-higher production dependency advisories; Dependabot configuration proposes weekly npm/Actions updates after publication, with no automatic merge/deploy. Production rollout remains manual and guarded by drain checks. |

## Optional production credential counter

After the script is deployed, from the production project directory:

```powershell
node .\scripts\auditCredentialStorage.cjs
```

It reads only credential fields, emits aggregated counts per collection, never
prints hashes, usernames, IDs, connection strings or passwords, and never
modifies an account. `legacyOrInvalid`, `bcryptBelow12` or `missing` require review;
do not repair them by changing production credentials automatically. A failed
inspection emits no partial counts. Prefer an existing read-only MongoDB account
for this manual audit where available.

## Rollout

These changes are local until explicitly published and installed. Dependency
changes require installation into an isolated candidate and native-module
validation; do not run `npm ci` in the live directory while workers use it.
Use the documented guarded deployment process after current financial work has
drained. No unguarded PM2 restart or automatic financial retry is part of this work.
