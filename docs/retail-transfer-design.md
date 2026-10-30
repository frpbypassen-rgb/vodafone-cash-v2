# Customer transfer view — local review

The retail transfer pages use the existing company transfer form partial and transfer controller modules without changing the account into a company or granting company permissions. Retail services use the customer/sub-client rate context and customer-scoped recent operations. The existing authenticated POST endpoints, operation PIN, financial idempotency and execution paths remain in charge of financial submissions.

Routes: `/client/transfers`, `/client/services/:serviceKey`, `/client/smart-transfer`, `/client/internal-transfer`. Company and agent rendering fall through to their existing controllers. Integrations are not included.

Local visual review: `node scripts/previewRetailTransfers.cjs` serves the actual EJS views at `http://127.0.0.1:4595/client/transfers`. This harness binds to loopback, has no database or worker startup, uses fixture data, and rejects financial submissions. It is not an application login session or a production deployment. Other customer sections still use their existing views; the harness labels unimplemented preview routes explicitly.

Validation: controller tests check retail ownership, sub-client scope, rate direction, unknown services, permissions, and company fallback. Browser checks cover six transfer services, gallery, internal transfer and message analysis at 320/390/768/1024/1440 pixels, plus shared review flow and refusal to submit money in the preview.

Validation outcome: 107 focused tests passed across retail transfer ownership, shared pricing/rules/parser, customer mobile shell, and company page/guard/navigation suites. ESLint passed for the changed JavaScript. A full-suite attempt encountered unrelated authentication enrollment tests requiring SESSION_SECRET/JWT_SECRET in the test process; it was stopped, and its generated migration report was restored. The full repository is not claimed release-ready by this local visual change.

## Customer home

`/client/dashboard` now renders `client/retail_dashboard` for direct retail users and sub-clients only. The existing company and agent dispatch remains unchanged. The home uses the shared retail navigation/header and displays the actual LYD balance, permission-aware actions, customer-scoped monthly transfer counts, and three recent transfers with their own source currencies. Pending counts are not represented as reserved money.

Monthly counts are read separately from the legacy bounded dashboard list, using the same server-calendar month as existing portal reports. Direct-user/sub-client ownership and a tenant ID (when available) scope both reads. The browser receives an explicit display DTO rather than executor information. Failure to load this optional summary produces a retry state, not fabricated zeros or a financial write.

The local preview now supports the home page with normal, empty, unavailable-summary, agent-funded and read-only fixtures. 67 focused checks passed, plus browser checks at 320, 390, 768, 1024 and 1440 pixels, night mode, notification panel bounds, and home-to-transfer navigation. Preview financial submissions remain blocked; no production deployment is included.

## Unified account pages and full directory

Retail hub contexts opt into the shared customer shell for account operations/deposits/summary/export, reports, settings, support, and device sessions. Existing form actions, report endpoints, CSRF checks, session controls, and financial mutations are unchanged. Legacy views remain compatibility fallbacks for contexts that do not opt in; company/agent/admin views remain separate.

The home directory explicitly links all 18 available sections for a direct customer. Central funding links remain absent for agency-funded sub-clients; transfer entry links stay absent for read-only accounts. There are no integration links. Settings render one responsive content tree instead of separate mobile/desktop forms. A transaction deep link carries its reference and calendar month, and the report page applies those values before its initial request.

Validation: 95 focused tests passed including session isolation/security coverage. A real local login checked all 18 directory destinations at five viewport widths, a single dock/shell on each page, one settings navigation, and finding a transfer from the previous month via the home link. No test submitted a financial transaction, sent a support message, changed a password, or revoked a session.
