# Merchant Webhooks interface

Company and agent owners share a compact, RTL Webhooks page. Endpoint cards sit beside delivery history on desktop; tablets and phones use one column. History shows eight rows initially and expands on demand. Filters operate on the fetched history without additional requests or polling.

The add/edit dialog is centered on desktop and becomes a bottom sheet on phones. Actions include URL copying, editing, testing, pausing, signing-key replacement, and deletion with an explicit warning. The existing server authorization, tenant isolation, HTTPS/SSRF validation, CSRF requirements, and delivery controls remain authoritative.

New signing keys appear only in the result dialog and are removed from its DOM when closed. Endpoint names and receiver errors/responses render as escaped text. Retry is offered only for failed deliveries on enabled endpoints. Skipped server delivery produces an informational notice rather than a false success message.

## Validation (2026-10-28)

- 23 passing tests across `merchantWebhookUi`, `merchantWebhookService`, and `merchantWebhookVisibility`; ESLint and `git diff --check` passed.
- Browser checks at 320, 390, 768, and 1366 CSS pixels: no horizontal overflow; desktop columns, tablet stacking, mobile sheet bounds, input focus, day/night/pharaonic themes verified.
- An ephemeral localhost fixture with in-memory data and no database or outbound transport exercised create, invalid HTTPS rejection, edit error retention, edit success, pause/resume, disabled test actions, test-skipped messaging, failed-delivery retry, filtering, show more, signing-key replacement, and confirmed deletion.
- Malicious-looking endpoint names and receiver responses stayed text with no injected image elements. Closing the signing dialog cleared its key field.
- The actual local company preview was also checked with its empty endpoint/history state. Real external webhook delivery is outside this UI verification; its worker is disabled in that preview.

This change does not perform a production deployment or worker handoff.
