# Login location and Authenticator presentation

The public login HTML was observed still referencing `login-location.js?v=20261027-policy` after the replacement JS had reached the server. Auth assets were served with a one-hour production cache. Replacing files alone did not invalidate an already compiled production EJS login view. Production readiness and matching Git/PIDs do not prove that a browser received fresh HTML/assets.

Login rendering now explicitly disables EJS caching and sends `private, no-store`. Only the authentication CSS/JS asset allowlist receives `no-store`; financial routes and normal static caching are unchanged.

The intermediate Authenticator page is now the compact OTP design. It posts the existing `mfaToken` and CSRF fields to the existing `/login` handler. It offers no email/Telegram substitute for mandatory Authenticator. The business email/Telegram chooser still follows that check when enabled.

When a live password challenge (up to five minutes) already contains valid coordinates in `pendingSecurityLocation`, the Authenticator page prefills those fields. It does not needlessly acquire another position. Missing, expired or invalid context does not prefill coordinates. A valid response from the same still-active coarse position request can also finish the pending precise fallback; completed/previous attempts cannot overwrite coordinates. No synthetic coordinates, IP geolocation service, new stored location category, or automatic security bypass is introduced.

Browser tests use a synthetic receiver and geolocation errors/coordinates; they prove form behavior at mobile and desktop dimensions, not availability of a physical device's location provider. The browser/OS may still fail to provide a location despite permission. If both acquisition modes fail on the actual device, inspect OS location services, browser permission, secure context and browser-supplied error rather than bypassing required-location policy.

## Deployment

This update includes backend rendering/static-header changes. Pulling files and refreshing the browser alone is insufficient: the running Node process must load them in a controlled maintenance window, after blocking admission and verifying no pending transactions or queue work. Do not kill a live financial process or perform an unrestricted restart while operations are unresolved. Existing server commission customizations must remain intact. No dependency installation is required.

After deployment, verify the public login page references the current JS URL, authentication assets send `Cache-Control: no-store`, and `/health/ready` PID matches PM2. Test Authenticator followed by the enabled email/Telegram choice with a nonfinancial test account. Never include passwords, OTPs, coordinates, cookies or bot tokens in diagnostic output.
