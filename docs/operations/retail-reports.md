# Retail transfer reports

`/client/account?tab=operations` uses mobile cards and a desktop table. Applied search/date/status/service filters are kept in the URL and in session storage under the account type/ID. Explicit deep links take priority over stored filters. Only filters are stored, not operation payloads. The legacy company/agent reporting screens and endpoints are unchanged.

The authenticated retail read endpoint reuses the operation-details owner/tenant scope. It returns up to 20 records with deterministic date/ID cursor pagination. Summaries cover all matching transfers, not just the current page. Requested amounts are separated by currency; the LYD cost summary includes completed transfers only. Subordinate accounts use their customer charge rather than the agency's private cost. Balance adjustments are not transfer rows in this screen.

Date boundaries use Africa/Tripoli independently of the host timezone. Custom ranges are limited to one year; search strings are escaped literal expressions and filter values are allowlisted. Queries have a bounded runtime. Pagination includes an as-of creation cutoff so new arrivals do not shift existing pages; this is not an immutable accounting snapshot, and current transaction state may change until the user refreshes.

Cards, reference buttons and table rows open the shared customer operation dialog. Receipt download/share uses the same authenticated ownership checks and file sharing behavior as the home screen. Closing a dialog preserves the loaded results and filter state. Errors clear stale results on a new query; a failed load-more retains existing results and can be retried. These endpoints never dispatch, settle, cancel or update financial records.
