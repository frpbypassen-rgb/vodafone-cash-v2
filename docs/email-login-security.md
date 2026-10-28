# Email login verification for company and agency accounts

The security page displays email verification below Authenticator in both portals. Owners use the email in the business profile. Staff use their own actor email; an employee cannot enroll the shared business mailbox. A missing address links owners to profile settings and directs staff to administration.

## Enrollment

1. An authenticated actor supplies the current password. CSRF and an actor-scoped limiter protect the endpoints under `/client/api/security/email-login` and `/agent-portal/api/security/email-login`.
2. The server resolves the account and destination itself, reserves a challenge on that actor, and sends the unified activation email. No caller-supplied actor ID or destination is trusted.
3. A six-digit code expires after five minutes. Resends require another password check and a 60-second database cooldown. Five failed attempts exhaust a challenge. A new challenge invalidates its predecessor.
4. Confirmation checks session, password fingerprint, current destination, delivery status, expiry and security revision. An atomic conditional update consumes the challenge, sets `otpDeliveryChannel=email`, pins the verified login address and invalidates any existing login challenge. Activation codes cannot authenticate a login or subscribe to daily reports.

Challenges are HMAC digests, excluded from normal model reads, and never returned or logged. Existing SMTP configuration is reused. Enrollment does not silently enable itself if sending fails or is disabled.

## Login and administration

The existing email OTP flow issues a new login challenge for every new login. For accounts verified through this flow, global password-only/emergency OTP shortcuts do not bypass the factor; email delivery failure blocks completion. Authenticator remains an additional requirement: its successful challenge is bound to actor, account type, credentials, session version and MFA configuration, and the email challenge follows before session establishment.

Administration reads the same actor `otpDeliveryChannel` and verified address. Admin saves invalidate pending enrollment codes by incrementing `emailOtpSettingsRevision`. Saving the same enabled, verified address preserves verification; disabling or changing it clears verification. Company owners remain `ClientEmployee` records; agency owners remain `User` records. Profile edits never silently redirect a previously confirmed factor; a changed address must be confirmed again from security settings.

Existing admin emergency behavior for accounts that have not enrolled through this new flow is preserved. No new self-service disable or recovery bypass is introduced. Daily report subscriptions remain independent.

## Verification / deployment

- `emailLoginEnrollment.test.js`: real disposable MongoDB tests for password gating, atomic activation, actor ownership, SMTP failure, cooldown, resend, attempts, expiry, admin changes, concurrent confirmation, HTTP authorization and CSRF.
- `emailLoginMfaProof.test.js`: proof binding and the combined Authenticator/email route ordering.
- `loginOtpService.test.js`: new challenges on successive company/agency/staff logins and failure without SMTP delivery.
- Browser layout review uses synthetic read-only fixtures for phone/desktop and day/night. Real delivery requires a configured SMTP server and a mailbox controlled by the account owner.

Schema additions are optional fields on existing actors; no destructive migration or new index is required. Local tests send no real mail and create no financial operations. Deployment remains a separate operation; do not restart the production process as part of this UI/security change.
