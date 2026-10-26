# Agency Telegram receipts

Agency managers can link several named private Telegram accounts in Settings → Notifications.
The existing account-link, webhook and receipt services are reused. No bot tokens
or arbitrary chat IDs are accepted by the settings API. The owner and tenant are
resolved from the authenticated session. Ordinary employees cannot redirect the
agency's receipts. Each account has its own display name, enable/pause switch,
rename, test-message and remove actions. Existing single-account links are shown
as a legacy card and remain usable. New accounts use a separate collection, so
the original unique account-link indexes do not need to be dropped or rewritten.

## Server configuration

Set `TELEGRAM_BOT_TOKEN`, a strong random `TELEGRAM_WEBHOOK_SECRET`, and optionally
`TELEGRAM_BOT_USERNAME=Ahrampay_bot`. The activation URL is fixed to the supplied
`https://t.me/Ahrampay_bot` bot; a different configured bot is rejected.
Configure an HTTPS `TELEGRAM_WEBHOOK_URL`, or
`PUBLIC_APP_URL` for the default `/webhooks/telegram` endpoint. Register the webhook
with the existing `telegramService.setWebhook()` helper. The endpoint is already
mounted before CSRF middleware and verifies Telegram's secret header.

Receipt images need the existing public signed receipt configuration
(`PUBLIC_APP_URL`, `RECEIPT_SHARE_SECRET`). The bot token alone does not make an
unreachable or unsigned receipt image deliverable. The local static preview does
not contact a real bot; use the configured server to verify an actual delivery.

## Behavior

- A cryptographically random linking code lasts ten minutes, is stored as a hash,
  and is consumed once. The Telegram `/start` link and manually pasted code work.
- Each new activation uses a separate `AGT-` token. Pending links can be renewed;
  renewal revokes the previous token without adding a duplicate card. Pausing or
  removing one bound account does not change other accounts or the WhatsApp mode.
- Telegram profiles and the time of the last bot interaction are shown. These
  are Telegram account bindings, not an enumeration of physical phone sessions.
- Every receipt is dispatched to the currently enabled destinations. One blocked
  destination does not stop the other accounts; duplicate chat destinations are
  suppressed and repeated chat bindings within an agency are rejected.
- Only private chats are accepted. Agency/account status, tenant and the code
  requester's management permission are rechecked when linking.
- Telegram receipt dispatch happens before WhatsApp provider checks, so Telegram
  does not require a configured WhatChimp template or a WhatsApp phone number.
- Completed, cancelled and split-part receipt images use their existing signed
  links. Each transaction/chat/proof has a separate durable claim to prevent
  duplicates, including after other proofs for that transaction are sent.
- Failed Telegram API responses may be retried. Ambiguous network failures are
  recorded as uncertain and are not automatically sent again. A process crash
  leaving a claim `sending` also requires review rather than a blind retry.
- Receipt delivery results stay visible in the existing Telegram monitoring page.
  Unlinking or disabling Telegram stops subsequent Telegram sends.

Startup creates indexes for account links, named agency connections, deliveries and receipt claims. Verify
index creation succeeds on the production database before relying on concurrency
protection. No financial data migration or balance mutation is performed.
