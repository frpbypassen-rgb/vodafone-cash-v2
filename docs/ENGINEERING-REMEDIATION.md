# Engineering remediation status

## Enforced now

- `src/` is a TypeScript-only boundary and is checked with strict TypeScript settings.
- The browser UI has zero jQuery runtime dependencies. Interactive screens use native modules, Fetch APIs, or Web Components.
- Merchant webhook endpoints and delivery logs are available to merchants at `/client/integrations/webhooks`.
- System-wide webhook failures and manual retries are available to administrators at `/admin/webhooks`.
- Production, clustered, and multi-instance deployments fail closed without Redis. In-memory locks are limited to an explicit single-process development deployment.
- `check:architecture`, `typecheck`, linting, and the release tests are mandatory parts of `check:release`.

## Migration boundary

EJS remains the server-rendered shell for authenticated routing and progressive enhancement while legacy route adapters are migrated. It no longer implies a jQuery dependency. Business and domain code added under `src/` must be TypeScript, and legacy JavaScript may only be removed with a tested replacement.
