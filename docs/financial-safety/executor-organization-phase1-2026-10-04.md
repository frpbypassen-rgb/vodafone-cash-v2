# Executor Organization Phase 1

Date: 2026-10-04. Scope: the local dirty worktree on
`codex/executor-financial-safety`; this is not a production deployment report.
Earlier changes were retained. No push, merge, or deployment was performed.

## Implemented

- Split 38 dashboard request handlers into eight responsibility-specific
  controllers, retaining the original import as an 11-line facade.
- Extracted static scripts from dashboard, employees, reports, and registration
  into 23 named page scripts. Removed two unused functions and unused callback
  or catch bindings. Existing routes, mutation payloads, and CSRF handling remain.
- Extracted four page CSS blocks without changing declaration or cascade order.
- Added pinned Prettier 3.9.9 as a development dependency, a scoped configuration,
  format/check commands, and a CI formatting step.
- Extended strict executor lint to the new browser files. Documented classic
  script dependencies explicitly instead of suppressing undefined-variable lint.
- Adapted source-contract tests to inspect assets actually referenced by the
  template. Browser XSS tests now serve the extracted scripts.
- Added 15 organization-contract test cases and a folder ownership guide in
  `docs/executor-portal-structure.md`.

## Size Changes

| File | Before | After |
| --- | ---: | ---: |
| Dashboard controller | 781 | 11 |
| Dashboard template | 1880 | 309 |
| Employee template | 1108 | 230 |
| Report template | 1043 | 203 |
| Registration template | 1211 | 220 |

This is separation, not disappearance of functionality: the extracted code is
preserved in named files. The largest new controller has 216 lines. Most browser
modules have fewer than 310 lines; the task renderer remains 521 lines.

## Preservation Evidence

All 38 handler implementations have identical normalized JavaScript ASTs before
and after extraction/formatting. The four extracted CSS blocks produce identical
canonical CSS to their original blocks, preserving rules and their order.

SHA-256 hashes of nine financial implementation files match the prior cleanup
baseline, which was unchanged at the start of this organization phase. This
does not mean the entire branch has no earlier financial changes.

Local artifacts: `test-artifacts/executor-organization-equivalence.json`,
`test-artifacts/executor-organization-regression.json`, and
`test-artifacts/executor-organization-ui/results.json`.

## Validation

- Full local suite: 1,832 passed tests in 228 passed suites; no failures or skips.
  The WhatsApp display test that timed out during the earlier phase passed in
  this complete run. This does not prove the earlier flakiness cannot recur.
- Scoped executor lint: zero errors and warnings, including extracted scripts.
- Whole-project lint: zero errors and 198 warnings outside the scoped gate.
- Scoped formatting, TypeScript, architecture policy, and `git diff --check`: passed.
- Visual regression: 36 cases and 72 before/after screenshots, with mobile
  360x640 and 390x844 and desktop 1280x900, both themes. Dashboard empty, normal,
  long, and active states were exercised; employee, report, and registration
  views were checked at 360px and desktop.
- All comparison cases retained identical text and card geometry, had no
  horizontal overflow, and kept the accept button above a visible mobile dock.
  Screenshots were nonblank; external fonts and icons were successfully loaded.
  There were no page errors or failed assets. Pixel comparison allows a maximum
  per-channel difference of 16 for browser rasterization; this is not a claim
  that every image is byte-identical.
- Failure-path browser checks verified accept-button restoration, profile
  navigation, and theme switching in both themes at all three dashboard sizes.
  All transaction requests were intercepted; no payments were sent.

The first static/UI test pass found three source-assertion failures after
formatting: whitespace-sensitive assertions and a newly added test's incorrect
assumption about report CSS order. These tests were corrected to preserve their
original behavioral checks and the actual report cascade. Browser XSS cases
passed on the first run.

The screenshot harness initially omitted registration fixture data and blocked
cross-origin font responses. These harness problems were corrected and the full
comparison was repeated. A desktop dock measurement was also corrected to
ignore an element hidden with zero height. These were not application fixes.

## Limits

This phase does not resolve independent risks in deposit creation, durable
post-commit events/audit, support event audience isolation, upload content
validation, or production infrastructure. It does not certify production
readiness. Other views and shared CSS still need incremental organization; inline
event handlers and classic-script globals remain intentionally compatible.
