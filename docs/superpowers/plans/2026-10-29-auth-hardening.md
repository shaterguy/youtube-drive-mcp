# Auth hardening implementation plan

Goal: fix the five reproduced authentication and authorization issues.
Spec: ../specs/2026-10-29-auth-hardening.md

1. Reuse baseline audit reproductions; add regression fixtures that fail for the actual defects.
2. Fix provider scope persistence, optional analytics reconnect and 403 reason classification together with direct regression tests.
3. Add grant generations, repeatable SQL triggers and token/revoke ordering while preserving legacy connections.
4. Test actual OAuth refresh/revoke/code issuance with real app checks and PostgreSQL-compatible SQL, including reconnect, stale tokens, consent reduction and migration re-entry.
5. Run the project suite, typecheck/build, independent auth/security review, and exact source identity checks.
6. Apply the additive migration, verify current connections/jobs, deploy exact reviewed source, and verify live MCP reads and token rotation without new login.

Scope excludes video changes, new uploads, Google Console changes, new schedulers/services, credential rotation and unrelated refactoring. Existing reproduction evidence is reused; only changed/missing assertions are run anew. PR-003 (version references) and PR-009 (auxiliary metadata) apply.
