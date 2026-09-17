# TypeScript migration policy

The application uses an incremental migration because replacing the financial runtime in one release would create unnecessary operational risk.

- New domain entities, application services, and reusable middleware belong in `src/` and must be TypeScript.
- Existing JavaScript routes remain adapters. Business logic should move out of them when changed.
- `npm run typecheck` is mandatory, and `check:release` runs it before tests.
- New browser screens should use API-driven Web Components or compiled TypeScript modules and must not add jQuery dependencies.
- A JavaScript file is removed only after its routes, tests, and operational behavior have a typed replacement.

This keeps every migration step deployable and prevents a long-running rewrite branch from diverging from production.
