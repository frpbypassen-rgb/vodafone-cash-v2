# Customer transfer view — local review

The retail transfer pages use the existing company transfer form partial and transfer controller modules without changing the account into a company or granting company permissions. Retail services use the customer/sub-client rate context and customer-scoped recent operations. The existing authenticated POST endpoints, operation PIN, financial idempotency and execution paths remain in charge of financial submissions.

Routes: `/client/transfers`, `/client/services/:serviceKey`, `/client/smart-transfer`, `/client/internal-transfer`. Company and agent rendering fall through to their existing controllers. Integrations are not included.

Local visual review: `node scripts/previewRetailTransfers.cjs` serves the actual EJS views at `http://127.0.0.1:4595/client/transfers`. This harness binds to loopback, has no database or worker startup, uses fixture data, and rejects financial submissions. It is not an application login session or a production deployment. Other customer sections still use their existing views; the harness labels unimplemented preview routes explicitly.

Validation: controller tests check retail ownership, sub-client scope, rate direction, unknown services, permissions, and company fallback. Browser checks cover six transfer services, gallery, internal transfer and message analysis at 320/390/768/1024/1440 pixels, plus shared review flow and refusal to submit money in the preview.

Validation outcome: 107 focused tests passed across retail transfer ownership, shared pricing/rules/parser, customer mobile shell, and company page/guard/navigation suites. ESLint passed for the changed JavaScript. A full-suite attempt encountered unrelated authentication enrollment tests requiring SESSION_SECRET/JWT_SECRET in the test process; it was stopped, and its generated migration report was restored. The full repository is not claimed release-ready by this local visual change.
