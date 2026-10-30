# Customer account security

Customer security uses the existing email enrollment, dedicated Telegram login bot, and login method choice services. Direct customers use User; agency customers use SubAccount. Company and agent actor mappings remain supported.

## Boundaries

- Password verification precedes enrollment. Only a delivered, unexpired, session-bound confirmation code activates a factor. Existing attempt and resend limits remain in force.
- User.profile email is a contact/enrollment candidate (businessProfile.email). SubAccount.contactEmail serves the same purpose. Editing these fields does not move an already verified login email. Confirmation writes the canonical emailOtpVerifiedEmail and revision.
- Customers and administration share otpDeliveryChannel, verified factor fields, and emailOtpSettingsRevision. Administration saves invalidate pending enrollment and login challenges. Customer admin editors carry the factor revision and reject stale saves atomically. No duplicated customer-specific security status is stored.
- Login method choice is pre-authentication only. A verified Authenticator proof remains mandatory when enabled. Account, factor, tenant, and parent changes invalidate the challenge; codes are single-use.
- Telegram encrypted link model indices are append-only to preserve outstanding company/agent links. Chat IDs and enrollment secrets remain excluded from presentation APIs.

## Operation

Reuse the existing SMTP and TELEGRAM_LOGIN_* server settings and dedicated login bot webhook. Missing delivery configuration is displayed as unavailable, without claiming successful enrollment. Existing BusinessLoginChallenge expiry indexing is unchanged; SubAccount adds optional security fields without a data rewrite.

Validation uses isolated MongoDB and mocked email/Telegram transports for full enrollment/login scenarios, plus the local demo browser for responsive layouts and authenticated status endpoints. Production delivery and production deployment are not performed by this change.
