# Customer notification settings

The retail notification page is `/client/settings?section=notifications`. It supports device price alerts, verified daily statement email and Telegram receipt notifications. Login OTP settings remain separate.

- Preferences use canonical owner/tenant records shared with the admin account editor. Saving checks revisions and atomically updates all three preferences; stale forms must refresh before writing.
- Email confirmation is required before enabling daily statements. Changing the notification destination does not change the login email or login factors. Confirmation codes expire, have attempt limits and are stored as hashes.
- Telegram links use the receipt bot `Ahrampay_bot`, not the login OTP bot. Linking does not automatically enable receipts; the customer must save that preference.
- Device subscriptions are scoped to the authenticated account and endpoint. Permission is requested only after an explicit enable action. Supported push service hosts are validated before sending.
- Each enabled channel exposes a throttled test action. Test requests are explicit and never create transfers.
- Leaving with unsaved preferences or a changed email draft prompts for confirmation. Failed refreshes and revision conflicts disable writes until the state is refreshed.

## Delivery requirements

Email uses the existing SMTP configuration. Telegram requires the existing receipt bot token and webhook secret. Web Push requires the existing VAPID configuration and browser support; an installed web app may be needed on mobile platforms. Missing configuration is shown on the page rather than reported as an active channel.

The customer statement worker runs only in production unless `CUSTOMER_REPORT_EMAIL_ENABLED=false`. It polls every minute and becomes due at 00:05 in the configured system timezone. It uses separate subscription/delivery collections and a unique daily job key. Consent and account status are checked again before sending. Ambiguous SMTP outcomes are marked uncertain and are not automatically resent.

Statements query only the customer identity and tenant; subordinate accounts use their own customer charge. Rendering is read-only and does not update balances, transactions, settlement or execution queues. Statements exceeding the supported row limit fail instead of silently omitting operations.

## Validation

Focused tests cover concurrent saves, stale forms, email confirmation, Telegram link consumption, test throttles, endpoint ownership, cross-account report privacy, subordinate pricing and ambiguous SMTP delivery. Browser checks cover 320/390/768/1440px in day/night modes, persistence, unsaved navigation, inbox opening and simulated activation/test flows. Browser transport simulations do not establish real SMTP, Telegram or push delivery; those require configured channels and an explicit authorized test.
