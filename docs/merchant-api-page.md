# Merchant API page

Company and agency owners reach a dedicated `/integrations/api` page from Settings → Integrations. It shares the Webhooks theme palette, stacks cards on phones, and uses two columns on desktop. Examples and documentation are collapsed initially. Existing keys remain masked; issuance/replacement and revocation require the existing password-confirmed, CSRF-protected routes.

## Security and data

- Rotation still uses the existing atomic replacement of the stored key hash and unsets the legacy key. No grace period, second key, or authentication cache was introduced.
- A newly issued key appears only in its result dialog. Closing the dialog or leaving the page clears its field. Keys and passwords are not persisted in browser storage, URLs, logs, examples, or activity responses.
- Owner and tenant checks are shared across status, the page, and activity. Administrative gates remain server-enforced. The visible status refreshes when focused, manually, and every 15 seconds while visible and outside a credential dialog.
- `GET /client/api/integrations/activity` and its agent equivalent return at most five API-created operations belonging to that owner. The allowlist is reference, status, and creation time, with a 2.5 second query limit. This is operation history, **not an HTTP access log**. No new financial writes or general request telemetry were added.
- API operations are identified by the existing Merchant API actor marker. Historical records lacking that marker are not relabeled. Missing legacy issuance dates display a dash rather than an inferred date.

## Verification (2026-10-28)

- 52 tests passed in six focused suites: API page, real integration routes, integration access, integration PDF contract, portal separation, and Webhooks UI. ESLint for touched JavaScript and `git diff --check` passed.
- Real API authentication tests cover companies and agents: the old token returns 401 immediately after replacement; the new token returns 200. Administrative disable, revocation, incorrect passwords, missing CSRF, non-owner access, tenant mismatch, concurrent rotation, and safe public metadata are covered.
- Disposable localhost UI fixtures exercised incorrect password handling, password clearing, issuance, explicit key copy, key-field cleanup, revocation, disabled administrative gates, example copy, and escaped activity values. No real merchant keys were changed through browser tests.
- Mobile widths 320/390 and desktop width 1366 rendered without horizontal overflow; day, night, and pharaonic themes were checked. The actual local company page and its Settings navigation were verified, including the password confirmation dialog and documentation link, with no browser errors.

The production runtime, transfer workers, and rollout remain unchanged by this local implementation.
