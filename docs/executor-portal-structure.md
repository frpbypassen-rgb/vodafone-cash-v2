# Executor Portal Structure

This organization phase changes file ownership and formatting, not financial rules.
The existing HTTP routes and controller import remain compatible.

## Request Handlers

`controllers/executorDashboardController.js` is the compatibility facade. Its
38 handlers are implemented under `controllers/executor/dashboard/`:

| Module | Ownership |
| --- | --- |
| `pagesController.js` | Dashboard, active task, overview, live tasks, alert acknowledgement |
| `proofImagesController.js` | Authorized proof image responses |
| `settingsController.js` | Profile and password settings |
| `employeesController.js` | Team accounts and employee reports access |
| `balancePoolsController.js` | Balance workspace and balance pool commands |
| `routingController.js` | Task routing and central-administration policy boundaries |
| `depositsController.js` | Deposit workspace, submission, and review |
| `quickExecuteController.js` | Preferences and dial preparation |
| `access.js` | Group identity comparison shared by these handlers |

Controllers delegate to existing services. Do not move ledger calculations into
these handlers or bypass service transaction and ownership checks.

`middlewares/requireExecutorPortalAuth.js` owns the shared session, MFA,
revocation and role checks for both portal and report routes. Manager routes
delegate to that same authentication check before applying their role policy.
GET authentication projections must retain group service fields and employee
pool membership; they must never select passwords, provider tokens or wallet PINs.

## Views and Browser Scripts

The dashboard, employees, reports, and registration views retain HTML, includes,
and small server-data bootstraps. Static JavaScript lives in
`public/js/executor/<page>/`; page styles live in
`public/css/executor/pages/<page>.css`.

The dashboard scripts are separated into navigation, state, proof input, routing,
task rendering, timers, quick execution, mutations, and polling. Employee scripts
separate workspace initialization, rendering, accounts, and balance pool actions.
Report scripts separate workspace initialization, rendering, operation details,
attachments, and filters. Registration validation lives in `register/form.js`.
Settings, deposit and support behavior lives in each page's `page.js`. Those
scripts use isolated closures; only their small server-data bootstraps remain
in EJS. Support names in the bootstrap must escape `<` for a script context.

These remain ordered classic scripts, not ES modules. Existing inline event
handlers rely on global function names. Do not reorder scripts or introduce
`async`/`defer` independently: initialization and polling must follow the relevant
state and function definitions. The compatibility bindings are documented in
`config/executor-browser-globals.js` and checked by ESLint.

Server data must remain serialized or escaped for its output context. Keep CSRF
bootstrap and the shared `executor-api.js` contract intact. Static public assets
must not contain EJS expressions, secrets, or server credentials.

## CSS Ordering

The page stylesheet replaces its original inline style block at the same point
in the cascade. Dashboard and employee page styles precede shared overrides;
report page styles follow them, matching their original position. Shared shell,
mobile, and theme files retain their URLs and order. Registration has its own
page stylesheet.

This phase does not consolidate theme overrides, remove `!important`, redesign
cards, or remove dynamic inline styles. Such changes require separate visual
regression coverage; formatting alone must not reorder declarations.

## Quality Gates

- `npm run lint:executor`: strict scoped lint, including the extracted browser scripts and shared API client.
- `npm run check:executor-format`: pinned Prettier check for the organized files.
- `npm run format:executor`: format that same scope; excludes financial services.
- `npm run test:executor`: run the portal suites by filename, with isolated test
  secrets. Financial integration fixtures use local ephemeral MongoDB instances.
- `npm run check:executor`: run lint, formatting, architecture, type checking and
  the portal test suites together.
- `tests/executorPortalOrganization.test.js`: ownership, facade, asset separation,
  load order, template compilation, module size, and CI formatting gate checks.

Existing behavioral, financial, ownership, and browser security tests remain
necessary. Source organization tests do not prove transaction correctness or
production readiness. TypeScript's existing `src` boundary does not type-check
all JavaScript in the portal.

Browser tests require Puppeteer's installed Chrome. When using a separately
installed Chrome, set `PUPPETEER_EXECUTABLE_PATH` to its executable before running
the checks; a missing browser is an environment failure, not a skipped test.

## Remaining Structural Work

The dashboard task renderer is still a large function, and classic-script
globals and inline handlers remain there. Shared navigation/security partials
still contain small inline scripts.
Markup contains long attributes and presentation styles. Shared CSS cascade
consolidation and stronger encapsulation should be separate, tested changes.
