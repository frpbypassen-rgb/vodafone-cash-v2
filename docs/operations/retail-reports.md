# Retail transfer reports

`/client/account?tab=operations` uses mobile cards and a desktop table. Applied search/date/status/service filters are kept in the URL and in session storage under the account type/ID. Explicit deep links take priority over stored filters. Only filters are stored, not operation payloads. The legacy company/agent reporting screens and endpoints are unchanged.

The authenticated retail read endpoint reuses the operation-details owner/tenant scope. It returns up to 20 records with deterministic date/ID cursor pagination. Summaries cover all matching transfers, not just the current page. Requested amounts are separated by currency; the LYD cost summary includes completed transfers only. Subordinate accounts use their customer charge rather than the agency's private cost. Balance adjustments are not transfer rows in this screen.

Date boundaries use Africa/Tripoli independently of the host timezone. Custom ranges are limited to one year; search strings are escaped literal expressions and filter values are allowlisted. Queries have a bounded runtime. Pagination includes an as-of creation cutoff so new arrivals do not shift existing pages; this is not an immutable accounting snapshot, and current transaction state may change until the user refreshes.

Cards, reference buttons and table rows open the shared customer operation dialog. Receipt download/share uses the same authenticated ownership checks and file sharing behavior as the home screen. Closing a dialog preserves the loaded results and filter state. Errors clear stale results on a new query; a failed load-more retains existing results and can be retried. These endpoints never dispatch, settle, cancel or update financial records.
# Downloadable full account statement

The customer reports header includes **تحميل التقرير**. It downloads a PDF using
the same `reports_pdf` template and financial summary calculations as the admin
statement. Only the selected day, month or custom period applies: search, status
and service filters affect the visible operations list, not the complete financial
statement. The UI explains this distinction before download.

`GET /client/api/retail-reports/download.pdf` resolves the active customer and
tenant from the session; caller-supplied account IDs and administrative scopes
are ignored. Customer/sub-account prices replace private parent pricing. The
shared customer statement reader supports periods while preserving daily email
statements. No settlement, transaction or balance mutations are performed.

Limits: 366 days, 5000 in-period rows, three exports per minute per authenticated
account, two concurrent customer PDF renders per process, bounded database
queries. A missing server PDF engine returns a safe error; the client retains its
search and filters. Configure the existing Chrome/Edge PDF engine on deployment.

Verified locally: real PDF download, rendered PDF content, 320/390px phone and
1440px desktop layouts, and regression tests for ownership, tenant isolation,
customer pricing, invalid dates, unavailable engine and existing daily statements.
