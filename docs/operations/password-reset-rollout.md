# Password reset rollout

Self-service reset stays off until this checklist is done on staging, and
it stays off in production until a separate owner approval. Do not merge
from this document. Do not add DNS records. Do not send a message to any
address other than `support@ahrampay.com`, and send that one message only
in the staging step below.

`PASSWORD_RESET_EMAIL_ENABLED` defaults to off. Only `1`, `true`, `yes`, or
`on` enable `POST /api/password-reset/start`, verify, and complete. Login
OTP does not read the flag. `WHATSAPP_OTP_ENABLED` stays `false`.

Windows host folder: `C:\Users\Administrator\Desktop\vodafone-cash-v2`.
PM2 process: `Ahram_Core_API`, port 3000. In PowerShell, do not use `$pid`
as a variable name. PowerShell already defines it.

## 1. Verifiable backup

Take the dump before any deploy. This step reads the database and writes
the dump files only. It does not change production documents.

```powershell
Set-Location C:\Users\Administrator\Desktop\vodafone-cash-v2
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$dumpDir = Join-Path 'C:\Users\Administrator\Desktop\vodafone-cash-backups' $stamp
New-Item -ItemType Directory -Force -Path $dumpDir | Out-Null
$mongoLine = Get-Content .\.env | Where-Object { $_ -like 'MONGO_URI=*' } | Select-Object -First 1
$mongoUri = $mongoLine.Substring('MONGO_URI='.Length)
mongodump --uri $mongoUri --out $dumpDir
Get-ChildItem -Path $dumpDir -Recurse -File | Get-FileHash -Algorithm SHA256 |
  Export-Csv -NoTypeInformation -Path (Join-Path $dumpDir 'sha256.csv')
```

Do not print `$mongoUri`. Record document counts for `users`,
`subaccounts`, `passwordresetrequests`, `mobiledevicesessions`, and
`sessions` (absent is a valid result for a collection that does not exist
yet). Keep the counts next to `sha256.csv`.

Verify the dump without writing to production. Prefer a restore into a
scratch database on staging, using a different database name from
production. `mongorestore --dryRun` is the alternative when a scratch
database is not available. Drop only that scratch database after the
counts match the dump. Do not drop a production database.

## 2. Staging first, flag off

Deploy this revision to staging with `PASSWORD_RESET_EMAIL_ENABLED` unset
or `false`. Restart so Node re-reads the file:

```powershell
Set-Location C:\Users\Administrator\Desktop\vodafone-cash-v2
pm2 restart Ahram_Core_API --update-env
```

Confirm the login page shows the support sentence (`0913731533` and
`support@ahrampay.com`) and does not show the reset form. `POST
/api/password-reset/start` still returns HTTP 200 `PASSWORD_RESET_STARTED`
and does not send mail. Verify and complete return
`PASSWORD_RESET_UNAVAILABLE`.

## 3. Readiness script

The script is read-only. It prints one `PASS`, `FAIL`, or `INFO` line per
check and a final `OVERALL PASS` or `OVERALL FAIL`. The process exit code
is 0 only for `OVERALL PASS`. It redacts URIs and secrets, does not restart
anything, does not send mail or WhatsApp, and does not insert, update, or
create collections or indexes (`autoIndex` and `autoCreate` are off).

```powershell
Set-Location C:\Users\Administrator\Desktop\vodafone-cash-v2
node .\scripts\checkPasswordResetReadiness.js --env-file .\.env
```

Stop if the overall line is not `OVERALL PASS`. An optional `--app-dir`
sets the directory used to resolve a relative `--env-file`. The script
reads that file only. It checks:

- MongoDB is a replica set with a writable primary, then a transaction that
  only reads `users` and aborts.
- Redis `PING` when Redis is in use. If `REDIS_ENABLED` is false, the Redis
  line is `INFO` unless `REDIS_REQUIRED=true`, which is `FAIL`.
- `SESSION_STORE`, `SESSION_SECRET` present with length at least 32 (the
  value is not printed), `SECURE_COOKIE`, and that the configured session
  store answers (mongo: `sessions` exists and is countable; redis: ping).
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, and `SMTP_FROM` are
  present. `EMAIL_OTP_ENABLED=true`. `OTP_DELIVERY_CHANNEL=email`.
- `WHATSAPP_OTP_ENABLED` and `WHATSAPP_LOGIN_OTP_ENABLED` are not truthy.
- Info only: `PASSWORD_RESET_EMAIL_ENABLED` and the effective
  `PASSWORD_RESET_COMPLETE_WINDOW_SECONDS` (default 600, clamped to 60–600).
- Read-only counts of eligible retail users and user-owned sub-accounts
  (`users`, `subaccounts`).

## 4. Enable on staging only

Set `PASSWORD_RESET_EMAIL_ENABLED=true` on the staging env file and restart
`Ahram_Core_API` with `--update-env`. Do not change production.

Use one dedicated test account. Its admin-saved address must be
`support@ahrampay.com` and its `otpDeliveryChannel` must already be
`email`. Start one reset for that account. That start is the single test
message. Do not run `scripts/sendLoginOtpTemplateV2Sample.js` in this
checklist, and do not send to any other recipient.

Then finish the reset with the code that arrived at
`support@ahrampay.com` and a new test password.

## 5. Confirm sessions are invalidated

On that test account only:

- Web: the old session cookie is rejected. `routes/clientPortal.js`
  compares `sessionVersion` with `clientSessionVersion` in
  `isActiveClientSession`. After success the stored `sessionVersion` is one
  higher, so the old cookie no longer matches.
- Mobile JWT: the old access token is rejected.
  `middlewares/jwtAuth.js` `ensureActiveCustomerSession` requires the token
  `sessionVersion` to equal the account.
- Device sessions: `mobiledevicesessions` rows for that account have
  `active: false` and `revokeReason: 'password_reset'`.
- connect-mongo: `sessions` documents for that account id were removed.

A login with the new password still works and receives a new session.

## 6. Log check

OTP codes and passwords must not appear in logs. From the host:

```powershell
$logDir = Join-Path $env:USERPROFILE '.pm2\logs'
Get-ChildItem -Path $logDir -Filter 'Ahram*Core*API*.log' -ErrorAction SilentlyContinue |
  Select-String -Pattern '(?i)(otp|code).{0,80}\d{6}|\bpassword\b\s*[:=]\s*\S+' |
  Select-Object -First 40 Path, LineNumber, Line
```

Investigate any hit before continuing. The support phone `0913731533`
contains digits, so read the line before treating it as a leaked code.

## 7. Stop

Staging ends here. Request a separate explicit owner approval before any
production change. Do not enable the flag on production in the same step.

## 8. Production, after that approval

Repeat the same order on production:

1. Backup, as in section 1, if the staging backup is not already the
   production snapshot taken immediately before this window.
2. Deploy with `PASSWORD_RESET_EMAIL_ENABLED=false` (or unset) and
   `pm2 restart Ahram_Core_API --update-env`.
3. Run the same readiness command. Continue only on `OVERALL PASS`.
4. Enable `PASSWORD_RESET_EMAIL_ENABLED=true` only after the approval that
   covers production, then restart with `--update-env`.
5. One reset for a dedicated test account whose approved address is
   `support@ahrampay.com`. No other recipient.
6. Repeat the session checks and the log search.

`WHATSAPP_OTP_ENABLED` remains `false`.

## Rollback

Level 1, preferred: set `PASSWORD_RESET_EMAIL_ENABLED=false` and run
`pm2 restart Ahram_Core_API --update-env`. Start, verify, and complete stop.
No email is sent and no account is changed. Login OTP, the WhatsApp OTP
kill switch, and the session fixes stay in the running code. Do not revert
a commit for this level.

Level 2, only when the whole pull request must leave the tree: revert the
entire PR #77 squash merge commit, then `pm2 restart Ahram_Core_API --update-env`.
Do not revert only `9a1bc521`. That commit sits on top of the earlier reset
path; reverting it alone would put that path back.

In both levels, `WHATSAPP_OTP_ENABLED` stays `false`. In-flight
`PasswordResetRequest` documents are not completed. They expire on the
existing code TTL and completion window. A document left in `completing`
should be set to `expired` by hand. That status is written only inside the
completion transaction, so it should not be visible after an abort.

## Deploy workflow risk

`.github/workflows/deploy.yml` (workflow name "Deploy to Server") listens
to a successful run of "Ahram Enterprise CI/CD Pipeline" (`.github/workflows/ci-cd.yml`)
on `main`, and it can also be started with `workflow_dispatch`. On a
successful CI conclusion it deploys that commit and runs
`node scripts/migrateTenantIsolation.js --apply --create-default`, then
reloads PM2. This pull request does not change that workflow.

Today CI on `main` fails (the security audit, plus the two known test
failures), so a push to `main` does not take that path. The risk remains:
a later green CI run on `main` deploys and applies that migration without
a separate production approval in this checklist. Keep
`PASSWORD_RESET_EMAIL_ENABLED` false in the server env file until section 8
is explicitly approved, including across any automatic deploy.
