# Zayn Speed recurring authentication rejection — 17 November 2026

## Evidence and limits

The production server was still running release `477bece2`, PID 17884, with
MongoDB and Redis ready and no restart since the preceding deployment. PM2
reported one live application; the older Core and Staging applications were
stopped. Matching provider credentials existed on two archived executor rows
and the single active Zayn Speed row. The direct environment credentials and
the special direct-executor employee were absent; retained logs contained no
direct-client login failures. These checks did not identify a second live
client inside this deployment as the trigger.

Application logs record upstream HTTP 429 / Code 429 at 14:36:07, 15:42:59
and 23:14:21 on 16 November, all using a local fallback rather than a provider
Retry-After. The last error is retained on ATT-2611-27721, subsequently
completed elsewhere. It must not be resent to recover authentication.

A single fresh GetToken request from the server at 2026-11-16T23:23:55Z
(17 November, 01:23:55 Africa/Tripoli) also returned HTTP 429 / Code 429,
with a rate-limit message, no Retry-After and no access token. No Inquiry or
Payment was sent. This reproduces an active upstream rejection, not merely
an old terminal log. The provider's limiting key, window and reason for
continuing the rejection are not exposed by the response.

## Reproduced local weaknesses

1. The five-minute cache ceiling also applied to JWTs whose provider-issued
   expiry was still in the future. A synthetic one-hour JWT caused another
   GetToken after six minutes. This can create unnecessary authentication
   traffic; the failed live response did not disclose the actual token format
   or lifetime, so it does not prove this alone caused the provider's limit.
2. Consecutive 429 replies without Retry-After always led to another eligible
   login after one minute, even when the provider continued refusing it.

## Changes

Provider-issued JWTs now remain cached until 15 seconds before their `exp`,
bounded by a 24-hour maximum. Tokens without a usable expiry retain the
existing five-minute fallback. A 401 still invalidates the specific rejected
token and refreshes a read once. There is no automatic Payment retry, no
credential change, and no new persistent token store.

Repeated 429 responses without a provider header increase the local on-demand
cooldown through 60, 120, 240, 480 and 900 seconds, capped at 900. A successful
login resets the sequence. Numeric and HTTP-date Retry-After values remain
authoritative. There is no background login loop. State remains bounded and
in-process; other external clients cannot be coordinated by this cache.

Safe successful-login diagnostics record the cache TTL only. Diagnostic
failures cannot discard an issued token. Passwords, tokens and complete
response/request objects are not logged.

## Verification and operational acceptance

Regression tests reproduce the five-minute JWT discard and fixed one-minute
backoff before the fix. Tests cover issuer expiry, the one-day ceiling, the
unchanged opaque-token fallback, adaptive cooldown and reset, provider-specified
waits, diagnostic-sink failure, and real HTTP reads six minutes apart using one
login. Broader provider/portal/atomicity regression checks accompany the release.

All 211 tests in the 12 affected suites passed, as did ESLint, TypeScript and
the architecture policy. No production payments were sent.

Production acceptance requires a fresh successful authenticated balance read
through the running application's administrator UI. Standalone diagnostic
processes have independent memory sessions and their successful login does not
warm the production application's cache; avoid using them as repeated probes.
A deployed mitigation or a passing loopback test alone does not establish
provider recovery. While GetToken continues returning 429, provider-side
recovery remains unverified; do not describe the service as restored.
