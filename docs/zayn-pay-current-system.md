# Zayn Pay API: Current Integration

## Scope

This document describes the current Zayn Pay external-aggregator integration and the changes required before enabling provider webhooks. Secrets, passwords, bearer tokens, and customer data are intentionally excluded.

## Provider contract found in the Postman collection

Base URL is supplied by provider configuration (`Local`/`Domain` in the collection); it must be stored in the executor configuration, never in source code.

Authentication:

- `POST /api/Account/GetToken`
- Request fields: `UserName`, `Password`, `AppType`, `AppId`, `VersionID`.
- Response fields: `Data.Access_Token`, `Data.Refresh_Token`, `Data.LoginMethod`.
- Subsequent calls use `Authorization: Bearer <Access_Token>` and the collection adds `app-version`.

Read-only account/service calls:

- `POST /api/Account/GetBalance`
- `POST /api/Services/GetServiceList`
- `POST /api/Services/GetPartialServiceList/ServiceId/{id}`
- `POST /api/V1/Transactions/CalculateFess`

Transaction calls:

- `POST /api/V1/Transactions/Inquiry`
- `POST /api/V1/Transactions/Payment`
- `POST /api/V1/Transactions/Print`

The transaction payload uses `Fields`, `CurrentServiceProviderId`, `ServiceId`, `MachineSerial`, and either `InqueryAmount`, `PaymentBillInfo`, or `Amount`, depending on the operation.

## Current application behavior

- Provider credentials and endpoint are configured per API executor; they are not read from this document at runtime.
- Payment execution is handled by the existing provider execution/lifecycle services.
- Provider results are persisted in `apiResultData` and unresolved results are protected from automatic refund or re-dispatch.
- Manual provider resolution is available to authorized administration users and requires provider evidence.
- The current integration must not call `Payment` again during polling. Polling may only use a provider status/inquiry endpoint after Zayn confirms its exact contract.

## Webhook readiness requirements

The Postman collection does not define a webhook endpoint, signature scheme, event names, retry behavior, or status schema. These must be obtained from Zayn before production activation.

Required provider details:

1. Webhook URL and HTTP method.
2. Signature header and signing algorithm.
3. Replay protection field or event ID.
4. Event names and definitive statuses.
5. Provider reference fields and timestamp format.
6. Retry policy and expected response status.
7. Whether webhook delivery is signed per tenant/executor.

## Safety rules for polling and webhook processing

- Never re-send `Payment` from a status check.
- Use a per-transaction lease/idempotency key so two workers cannot poll the same operation concurrently.
- Stop polling after a definitive provider result or a configured deadline; a deadline is not proof of failure.
- Treat webhook and polling results through one idempotent reconciliation service.
- Do not post a second ledger movement when the operation was already committed.
- Reject invalid signatures, unknown events, stale events, and conflicting final results.
- Redact tokens, passwords, phone numbers, and full provider payloads from logs.

## Deployment checklist

- Rotate credentials that appeared in exported Postman files.
- Store Zayn credentials in the server secret store or `.env`, never Git.
- Configure the provider's real HTTPS webhook URL only after signature verification is implemented.
- Run provider sandbox tests for success, pending, rejected, timeout, duplicate webhook, and poll/webhook race cases.
