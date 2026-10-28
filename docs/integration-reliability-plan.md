# Integration reliability implementation

Scope: company and agency portals, shared merchant authentication/transfer API, merchant Webhooks, and synchronized administration. Local implementation and isolated tests only; no production cutover or real financial test transfers.

1. Harden manual webhook retries: atomic failed-only transition, preserve attempt counts, respect attempt budget, reject delivered/in-flight retries and concurrent double claims. Verify ownership and tenant boundaries.
2. Add optional `Idempotency-Key` to merchant transfer creation: owner/tenant-scoped hashed key and canonical fingerprint, persist the original response with the financial transaction, replay without additional debit/ledger/dispatch, reject mismatches and in-progress conflicts. Require MongoDB transactions for keyed requests; preserve legacy behavior without a key.
3. Add an allowlisted, bounded technical event store and owner-scoped reads for IP denials and delivery failures. Store no tokens/passwords/payloads/receiver response bodies.
4. Add a read-only readiness summary: API/key/IP configuration, webhook endpoint counts, global transport switch, last delivery; expose administrative permission separately from operational readiness. No test transfer or external webhook send.
5. Rebuild the settings summary: compact two-column desktop/stacked mobile cards; explicit stale/error/loading states, last successful check, readiness action, IP and webhook metadata, small technical event list.
6. Defer email and Telegram initialization/polling until their settings panel opens, for both portals.
7. Run focused security/concurrency/regression checks and real browser verification on phone/desktop, document operational requirements and remaining limitations.

Completed locally. See `integration-reliability.md` for the API contract, requirements, validation and remaining limitations. No production cutover was performed.
