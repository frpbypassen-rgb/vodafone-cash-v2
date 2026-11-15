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
3. Automatic polling/completion respects `FINANCIAL_SCHEDULERS_ENABLED` and
   `EXTERNAL_API_ENABLED`. The executor page warns if financial scheduling is
   disabled. Manual, individually confirmed reconciliation can still use the
   existing immediate completion path without enabling other schedulers.
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

## Validation

Focused Jest suites cover the contract, receipt fields, signed raw-body
callbacks, persistence failure, replay, scoped reconciliation, stale previews
and the prepaid balance guard. `tests/kenanProvider.integration.cjs` uses a real
temporary Mongo replica set and a loopback provider to prove that competing
finalizers post one debit and never repeat POST. Runtime tests use mock data;
production acceptance still requires an actual matching provider response.
