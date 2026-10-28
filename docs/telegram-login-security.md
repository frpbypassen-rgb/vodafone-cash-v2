# Company and agency Telegram login verification

The shared security page shows Telegram below email, followed by a choice of login-code channel. `@Ahram_otp_bot` is the dedicated OTP bot. Receipt/transfer notifications and their bot remain separate. One confirmed Telegram account is stored per login actor, not per physical device: Telegram can synchronize the account on multiple devices.

## Activation and switching

- An authenticated actor supplies their current password. The server generates an opaque, authenticated, encrypted deep link lasting five minutes. It contains no readable account ID, password or login OTP. The database stores its HMAC, browser binding, security revision and credential fingerprint.
- Only the dedicated webhook can process `/start`. It requires its own secret, a private chat and matching Telegram sender/chat IDs. The first valid update claims the pending link atomically and sends a six-digit **enrollment** code. Duplicate updates do not resend it.
- The website consumes that code atomically after checking expiry, browser binding, credentials, revision and attempts. Five wrong attempts exhaust it. Resending/replacing requires another password check and a database cooldown of 60 seconds. Until website confirmation, the candidate chat receives no login codes.
- A confirmed link preserves an existing email selection. If OTP was off, initial confirmed enrollment selects Telegram. Verifying an email while Telegram is selected likewise preserves Telegram.
- Switching between confirmed channels requires the current password **and a distinct code sent to the current channel**. It does not silently fall back when delivery fails. Pending channel changes are purpose-bound, single-use and expire after five minutes. Removing Telegram is possible after choosing a confirmed email channel; a selected Telegram link cannot be silently removed by self-service.
- Admin saves use the same `otpDeliveryChannel` (`email`, `telegram`, legacy `whatsapp` meaning OTP off). They invalidate pending enrollments, channel-change challenges and login codes. Admin cannot select an unconfirmed Telegram account. Legacy edit forms preserve an existing Telegram choice rather than switching it off accidentally. Admin account details and per-actor settings show the selected channel and confirmed Telegram state.

## Login

Every new Telegram login sends a fresh OTP only to the confirmed chat under the configured bot identity. The delivery service rechecks the current actor, revision, selected channel and login challenge before sending. Unconfirmed, revoked, unconfigured or failed Telegram delivery blocks login, including in the global password-only/emergency OTP mode. No automatic email fallback is introduced.

Authenticator remains an additional requirement when enabled. Its proof, pending location and selected OTP channel are explicitly preserved across pre-authentication session regeneration. The verification screen names the actual delivery channel. Session establishment still waits for both factors.

## Configuration (do not paste secrets into chat or commit them)

Set these values privately on the server:

```dotenv
TELEGRAM_LOGIN_BOT_USERNAME=Ahram_otp_bot
TELEGRAM_LOGIN_BOT_TOKEN=<dedicated OTP bot token>
TELEGRAM_LOGIN_WEBHOOK_SECRET=<32-256 random letters, digits, underscore or hyphen>
PUBLIC_APP_URL=https://ahrampay.com
```

The OTP bot token must belong to a different bot from `TELEGRAM_BOT_TOKEN`. The configured bot ID is pinned with every confirmed link. Rotating a token for the same bot preserves existing links; changing to another bot requires re-enrollment and a deliberate channel/recovery decision.

After deploying the code and setting secrets, inspect the configuration without registering anything:

```powershell
node scripts/registerTelegramLoginWebhook.cjs
```

Then register when ready:

```powershell
node scripts/registerTelegramLoginWebhook.cjs --apply
```

The registration script verifies `getMe` against the configured bot before registering `/webhooks/telegram-login`. It does not discard pending updates or print tokens. HTTPS routing must reach this endpoint without a browser login; requests are authenticated with the Telegram secret header before any code handling. Application CSRF continues to protect portal POSTs.

Local integration sandboxes explicitly disable both OTP and receipt bot credentials. Tests use disposable MongoDB and mocked Telegram/email transports. No real bot registration, messages or financial operations are part of the tests. Existing actors need no destructive schema migration and the encrypted link resolves its actor directly by ID without a new lookup index.

## Verification

`telegramLoginSecurity.test.js` covers password gating, opaque links, duplicate updates, forged tokens, private-chat binding, cooldown, expiry, attempts, confirmation, separate actors, authenticated HTTP/CSRF flows, channel switching and login failure behavior. `telegramLoginTransport.test.js` covers secret validation, dedicated bot isolation, webhook authorization and redaction. `emailLoginMfaProof.test.js` exercises the actual login transition across real session regeneration.
