# YouTube Drive MCP v0.1.0-dev1

AC-01: Main Google account alone owns the MCP login, session and OAuth grants.
AC-02: Main-account Drive authorization is separate from channel-account YouTube authorization.
AC-03: Durable encrypted provider credentials refresh before expiry without revoking MCP grants; concurrent refresh is serialized and absent replacement refresh tokens preserve existing tokens.
AC-04: Drive videos stream in bounded chunks into a pinned channel's resumable YouTube session; interrupted responses recover by querying the same session and never create an automatic duplicate.
AC-05: Channel/video/playlist reads and explicit metadata, thumbnail, scheduling and playlist operations use the pinned channel account.
SAFE-01: No arbitrary network destinations, no token exposure, CSRF/PKCE/nonce/session binding, owner-only identity and no existing service mutation.
REL-01: Independently reviewed source, reproducible tests/build and Vercel live endpoint; remote deployment and credentials owned by orchestrator.

Assumptions: personal single-owner deployment, existing provider credentials provisioned separately, new Postgres database. Google project audience production and API enablement are external preconditions; revoked Google consent needs service-only reauthorization.
Validation: secret-free unit/integration fixtures, PostgreSQL-compatible PGlite tests, TypeScript build, then separate verification. Evidence is NEWLY_REQUIRED because this is a new repository.
APPLICABLE_PREVENTION_RULES: NONE for first implementation; PR-009 applies if only bookkeeping remains.
Scope: this repository only. No existing video changes, actual uploads, DriveWorker source or database changes by builder.

## Orchestrator acceptance mapping

AC01 main-only MCP identity; AC02 private main Drive reads; AC03 separate channel-account binding to UCrTwN67Kw-1cX8BKGbryQag; AC04 durable refresh including concurrent/401/missing replacement/transient behavior; AC05 Drive→YouTube completion/resume/idempotency; AC06 OAuth grant/signing/vault continuity across deployment and expired/deleted browser sessions; AC07 protected /mcp challenge/discovery and account/transfer UI.

Tests: core.test.ts→AC01/SAFE; database.test.ts→AC03/AC04; upload-integration.test.ts→AC02/AC03/AC05; offline-grant.test.ts→AC06 actual library refresh/logout; service.test.ts→metadata non-regression; deployed endpoint checks→AC07.
