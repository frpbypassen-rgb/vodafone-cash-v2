# Kenan company API integration

Implemented against the two-page Kenan company guide supplied on 2026-11-15.
The service URL is an administrator setting: temporary tunnel URLs in the guide
are not defaults in source. API tokens are never displayed in history or logs.

## Capability map

| Guide capability | Implementation |
| --- | --- |
| Bearer authentication, JSON, integer piastres | `services/kenanProviderService.js` |
| Egyptian wallet phone; 50–60000 whole EGP | Validation before dispatch |
| POST create and preserve zero-prefixed reference | Durable dispatch claim and majority reference write before queue continuation |
| GET order by reference | Reference, phone and amount must match before success |
| GET latest 100 orders | Administrator's Kenan history page |
| GET deposits | Read-only history; never automatically funds a local account |
| GET credit/reserved/available | Provider balance snapshot, distinct from local ledger balance |
| All eight order statuses | Only `success` can complete; in-progress states retain holds |
| Complete receipt | Nullable metadata retained; operator phone, completion time and fee in generated receipt; full provider balance/deduction details in administrator history |
| 400/401/404/409/429 and retry delay | Sanitized failures; uncertain POST is never automatically repeated |
| HMAC-SHA256 webhook | `/webhooks/kenan/:executorId`, raw UTF-8 bytes, `X-Kenan-Signature` hex, timing-safe verification |
| Durable webhook acknowledgement and duplicates | Majority-persisted event, deterministic account/body event ID; ACK after save; wake GET polling without trusting callback order |
| Existing paid order reconciliation | Master-only preview, fresh matching GET, row-version guard, atomic existing ledger completion, audit and idempotency |

## Operations

1. Configure the current HTTPS URL and API token on the API executor account.
2. Keep the local accounting policy explicit. A prepaid executor needs local
   funding; provider credit is not silently imported as local ledger funding.
3. Saved-reference polling and verified completion use the independent
   `KENAN_AUTO_FOLLOWUP_ENABLED` switch (on by default in production, explicit
   opt-in in staging), plus `EXTERNAL_API_ENABLED` and the full runtime role.
   They run every five seconds without enabling unrelated financial schedulers.
   Pending statuses continue GET polling; transport failures retain a durable
   sixty-second retry lease. Success is freshly verified before the existing
   atomic prepaid/credit ledger completion. Insufficient local prepaid funding
   leaves success awaiting settlement and retries without another POST.
   Set `KENAN_AUTO_FOLLOWUP_ENABLED=false` to pause Kenan follow-up independently.
   The executor page displays the effective follow-up state.
4. For webhooks, agree a signing key with Kenan, save it through the master-only
   form, and provide the displayed HTTPS callback URL to Kenan. The shared key
   is UTF-8 text, not hex-decoded. Callback registration is performed by Kenan;
   implementing the endpoint does not register it with their service.
5. A callback only persists an event and wakes a GET check. Failed persistence
   returns non-2xx for retry; duplicate or older callbacks cannot reverse a
   terminal result or create another payment.

Missing historical receipt values remain `null` and display as unavailable,
never as zero. Provider-company balances stay in the protected administrator
history rather than the customer-facing image.

Receipts show the actual `executor_phone` as the executor number, the string
Kenan reference (including leading zeros), local order number, customer phone,
amount, provider completion time, fee and provider support phone when present.
An unavailable executor phone is never replaced with the order reference.
Completed Kenan orders missing a receipt are checked against a fresh matching
provider success and receive their receipt without balance or ledger changes.
This does not repair historical manual-completion accounting discrepancies.

## Validation

Focused Jest suites cover the contract, receipt fields, signed raw-body
callbacks, persistence failure, replay, scoped reconciliation, stale previews
and the prepaid balance guard. `tests/kenanProvider.integration.cjs` uses a real
temporary Mongo replica set and a loopback provider to prove that competing
finalizers post one debit and never repeat POST. Runtime tests use mock data;
production acceptance still requires an actual matching provider response.
