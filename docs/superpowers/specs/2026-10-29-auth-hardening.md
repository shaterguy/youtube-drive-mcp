# Authentication continuity and revocation

Request: fix all five audited issues and deploy, retaining the current Google connections and upload jobs.
Baseline: 721c864929111bafc698f65a6ccc339604d5e822. Target: v0.1.0-dev3.

AC-01: Concurrent same-token MCP refresh requests must converge on the maintained provider's encrypted replay response. Serialize token issuance and revocation across instances with a bounded local queue and fixed advisory lock (personal single-owner service). Client authentication, resource/scope validation and replay expiry remain provider-owned.
AC-02: Only proven insufficient Google scope requests analytics consent. API activation/project configuration, general forbidden, unknown and quota errors retain distinct fixed error codes without raw provider messages.
AC-03: Optional analytics permission can be removed; ordinary YouTube reconnection with base permissions still works, preserving the pinned Google subject and channel.
AC-04: Explicit refresh scope responses replace stored permissions atomically; omitted scope preserves existing permissions. Recheck analytics permissions after token renewal.
AC-05: A committed MCP revocation blocks subsequent requests with previously issued JWTs. Current consent/grant/client/owner checks remain live. Durable generations and SQL revocation triggers distinguish normal rotation from explicit revocation. New code authorization replaces the old client family; old JWTs and refresh tokens cannot revive after reconnect.

Migration: additive mcp_grants table, repeatable triggers and consent bootstrap. Legacy JWT compatibility preserves existing connections, including a predeployment rotation gap. Existing tombstones are never overwritten. It does not reconstruct revocations already ignored by the old runtime. Future explicit revocation disables legacy access immediately. Provider credentials, upload jobs, scopes requested and stable secrets remain unchanged.

Alternatives: JWT lifetime alone leaves the audited five-minute gap; browser-session checks recreate periodic reconnects; clearing all existing connections on deployment violates continuity. Durable grants provide immediate future revocation without those side effects.

SAFE-01: No real token/secret printing or public-video mutation. OAuth state/PKCE/nonce, two Google accounts, pinned channel and vault AAD remain intact.
SAFE-02: Consent/client checks, revoked generations, replay protection, local queue bounds and cross-instance lock failure cleanup remain tested. Test real provider code plus PostgreSQL-compatible triggers; do not label PGlite a multi-connection PostgreSQL test.
REL-01: Preserve reviewed exact source on GitHub, apply verified additive migration, deploy the same candidate to the canonical existing service and read back the existing MCP connection plus provider status. Google Console Testing mode is a separate unverified deployment setting.
