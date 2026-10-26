# YouTube Drive MCP Implementation Plan

> **For agentic workers:** Use the assigned builder and separate verification roles; continue without an additional approval request, as directed by the owner.

**Goal:** Upload private files from the main Google Drive into the separately authorized YouTube channel without repeating MCP connection on ordinary token expiry.
**Architecture:** Better Auth issues independent MCP OAuth grants; a Postgres vault encrypts and refreshes role-specific Google tokens. Durable resumable jobs freeze a Drive revision and send 8 MiB chunks to the pinned channel.
**Tech Stack:** Node 24, TypeScript, Better Auth 1.7.9, MCP server 2.3.1, Google Auth Library 11.3.1, Postgres.
**Spec:** `docs/work-packet.md` plus the orchestrator's AC01–AC07 work packet.

## Global Constraints

Canonical origin `https://youtube-drive-mcp.vercel.app`; owner `shaterguy@gmail.com`; channel `UCrTwN67Kw-1cX8BKGbryQag`; version `0.1.0-dev1`. Existing DriveWorker code and DB are read-only. No live upload or video changes during builder verification.

## Review Focus

Concurrent refresh preserves replacement tokens; missing refresh_token preserves the existing value. Google invalid_grant affects its own connection, not MCP authorization. Callback replay or another session cannot replace credentials. Lost final upload response is resolved against the same session. A changed source or wrong channel never silently redirects an upload.

## Tasks

- [ ] Auth and vault: `src/auth.ts`, `src/providers.ts`, `src/crypto.ts`, `sql/*`; fixtures assert owner-only sign-in, service session/nonce binding and token lifecycle. Run `npm test` and `npm run typecheck`.
- [ ] Transfer: `src/uploads.ts`; fixtures cover source revision, chunk range, resume offset, idempotency and lost-response recovery. Run `node --test tests/uploads.test.ts`.
- [ ] Management and transport: `src/service.ts`, `src/mcp.ts`, `src/runtime.ts`, `api/index.ts`; fixtures assert channel ownership, bounded responses, MCP authentication boundary and discovery.
- [ ] Delivery: README, migration script and emergency manual-only build workflow; run the complete test command and build, then hand source and remaining external preconditions to the orchestrator.
