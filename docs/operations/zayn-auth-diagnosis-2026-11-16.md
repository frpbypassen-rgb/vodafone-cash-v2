# Zayn Speed authentication investigation — 16 November 2026

## Production evidence

The retained application log records upstream HTTP 429 and body Code 429 at
2026-11-15 23:05:58 (system time), matching the user's exact reported time.
The transaction history for ATT-2611-27432 retains that authentication error;
the row subsequently completed under a different executor. A historical API
log on a completed row is not a fresh connectivity check.

One read-only check from the production server at 2026-11-16T10:59:25Z used
the active **Zayn Speed** executor, not one of the archived Zayn accounts.
GetToken returned HTTP 200 / Code 200 and GetBalance returned HTTP 200 /
Code 200. No Inquiry or Payment was sent. The current account credentials
therefore authenticated successfully at the time of inspection.

The older records prove upstream authentication throttling, but do not reveal
whether the provider counted attempts by account, IP, device or another key.
The recorded 60 seconds does not establish a provider-specified unblock time:
the previous implementation used 60 seconds when Retry-After was absent.

## Reproduced internal defect and correction

The direct ZaynPay client had its own token and login flight, separate from
the aggregator/queue client. It lacked the shared throttle: five sequential
rejected direct inquiries generated five GetToken requests during an upstream
120-second Retry-After. The two clients also logged in separately when using
the same URL, credentials and application identity. These are confirmed
amplifiers of authentication traffic, not proof of what triggered the exact
historical provider rejection.

Both clients now use the same bounded in-process session service, token
expiry and cooldown. Authentication headers are consistent across clients.
An inquiry may refresh authentication once after 401; invalidation is scoped
to the actual rejected token so a late response cannot erase a newer session.
The Payment endpoint is never retried by this change.

Errors distinguish a provider Retry-After from the local fallback. Safe
HTTP/code/source diagnostics persist in the process log and structured result,
including during cached cooldowns. No credentials, tokens, raw response bodies
or request configuration are retained in error state or emitted in diagnostics.

## Verification and rollout

Regression tests reproduce the old failures before the change. They verify
shared expiry, credential isolation, cooldown expiry, provider header versus
fallback, and one login across 50 mixed direct/aggregator reads using real
Axios against a local HTTP fixture, under both success and HTTP 429. These
fixtures send no production payments. All 204 tests across 12 affected suites
passed, including provider payment safety, transaction atomicity, mobile/web
execution, runtime isolation and Kenan regression coverage. ESLint, TypeScript
and architecture policy checks also passed. One fixture was updated to clear
the newly shared session between tests rather than only its old client token;
the complete set of 12 suites was then rerun successfully.

Deployment was explicitly deferred by the user. No application restart,
financial mutation, credential change or replay of an old operation was made.
Kenan contract v7 is already pushed separately; its guarded server deployment
stopped before restart because open transactions were present.

The shared session remains local to one Node process. Multiple application
processes or external clients using the same credentials require additional
coordination. This correction reduces unnecessary logins; it cannot guarantee
that an upstream service will never apply a rate limit.
