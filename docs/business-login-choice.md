# Company and agency login-code choice

After password verification and any required Authenticator challenge, business accounts with login OTP enabled reach `/client/verify`. No message is sent until they select email or Telegram and press Send. Agency owners, company login actors and agency staff share the screen. Retail/executor/admin verification screens retain their existing flows.

Only approved email/Telegram identities are eligible. Ownership confirmation alone does not authorize a new alternative to bypass the existing factor: a current-channel code in settings grants the destination (and preserves the source grant), bound to the exact email or Telegram chat/bot identity. Initial enrollment grants its first selected factor. Replacing or unlinking an identity invalidates its grant. The current administrator-selected channel is retained as trusted legacy identity; other previously linked identities need the current-channel approval flow before appearing as alternatives. An unconfigured transport appears unavailable and cannot be selected. Authenticator is never an alternative delivery channel: when enabled it must have been verified before starting, sending or consuming a business OTP attempt. Active business OTP cannot be bypassed by password-only/emergency mode.

Each pre-authentication browser session owns a private `BusinessLoginChallenge` bound to its regenerated session ID and a fingerprint of credentials, session/security revisions, account status, parent linkage, tenant, MFA configuration and delivery identities. Selecting a method does not update `otpDeliveryChannel` or other saved account settings. Authenticated sessions and financial operations are not created by sending codes.

Sending atomically claims the challenge generation and enforces a database cooldown of 60 seconds per actor across both methods. A late provider reply cannot restore a canceled generation. Switching methods invalidates the previous code immediately. Delivery failures do not trigger fallback and leave no usable code. Codes last up to five minutes within a ten-minute password/MFA attempt, are HMAC-hashed with purpose and generation, allow five failed attempts, and are consumed once. Challenges expose no full email, private chat ID, hash, credentials or session binding in the UI/API. All portal POSTs retain CSRF and rate limiting.

The responsive RTL screen uses local assets, keyboard-accessible method buttons, masked destinations, six numeric fields with paste/autofill support, expiration/resend counters, explicit submit and a safe Telegram open link. It supports light/dark themes and a blocked/restart state when the session expires or account settings change.

## Deployment

The new collection has an expiration index; expiry checks are enforced in application code even if background TTL cleanup has not been provisioned. Before normal production use, create the index with the application's private environment configuration:

```powershell
node scripts/ensureBusinessOtpIndexes.cjs
```

This creates indexes only on the authentication-challenge collection. It does not migrate financial data or restart the application. No external mail, Telegram registration or production database changes are performed by the local automated tests.

## Validation

`businessLoginChoice.test.js` uses disposable MongoDB and mocked delivery to cover initial no-send state, confirmed destinations, forged channels, cross-browser binding, concurrent send/consume, late delivery after cancellation, common cooldown, single-use codes, account/admin changes, attempt lockout, mandatory Authenticator, final session establishment and CSRF. `emailLoginMfaProof.test.js` verifies proof/location preservation into the pre-authentication choice stage.
