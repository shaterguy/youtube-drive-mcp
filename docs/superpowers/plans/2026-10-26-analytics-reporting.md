# Analytics and Reporting Implementation Plan
> For agentic workers: use superpowers:subagent-driven-development or executing-plans. The user already approved implementation; do not request another design approval.
Goal: Provide pinned-channel Analytics and Reporting through the existing web/mobile MCP.
Architecture: A focused analytics service reuses Providers and the existing owner/channel binding. Add strict MCP tools and authenticated same-origin UI routes, with no new background service or database credential store.
Tech Stack: existing Node24, TypeScript, Zod, pg, MCP server and Better Auth.
Spec: docs/superpowers/specs/2026-10-26-analytics-reporting.md

## Global Constraints
- Baseline 517a8c75cd8c7047e65823dc39ac2904b287e800, target v0.1.0-dev2.
- Preserve owner login, two Google connections, upload_jobs, session encryption, existing tools and endpoint.
- Analytics missing scopes must not invalidate uploading.
- Reporting downloads must be bounded and Google-only; raw download URLs and tokens must not be returned.
- APPLICABLE_PREVENTION_RULES=PR-003. Search exact old version references before identity mutation and update intentional version assertions only.
- No source or private metrics in Drive backups, no new GitHub Actions unless a necessary platform condition appears.

## Review Focus
1. Existing upload grants lacking analytics scopes remain usable.
2. Wrong channel/job/report and user-selected external URLs cannot cross the credential boundary.
3. Dates, incompatible report profiles and sparse results cannot yield fabricated totals.
4. CSV quoted newlines, oversized data and row truncation are explicit and safe.
5. OAuth partial/failed consent preserves previous service credentials and MCP grants.

## Task 1: One cohesive Analytics/Reporting capability
Files: create src/analytics.ts and focused tests; modify src/config.ts, src/providers.ts, src/service.ts or imports, src/mcp.ts, src/ui.ts, README.md and intentional package/version references.
Interfaces: strict profile/date/video inputs; fixed-channel analytics results; reporting types/jobs/reports and bounded parsed report result; same-origin UI uses the same production methods.
- [ ] Read related source/tests and search version references; write failing behavior tests covering AC01-06 and Review Focus.
- [ ] Run new tests and confirm expected failures.
- [ ] Implement minimum cohesive service/tool/consent/UI changes; no unrelated refactoring or schema migration unless necessary.
- [ ] Run npm test, npm run typecheck, npm run build, git diff --check and record exact candidate evidence.
- [ ] Commit source and provide exact full diff for independent security and functional review.

## Task 2: Publish and live integration
- [ ] After independent PASS, preserve exact source remotely and deploy to existing production project.
- [ ] Enable only necessary Google APIs and use normal existing-browser channel-account incremental consent; never print tokens.
- [ ] Verify scopes, ordinary upload/read access, Analytics summary/daily/retention query and Reporting reportTypes.
- [ ] Read existing jobs first, enable supported required report jobs once and read back. First report pending is an expected data-availability state; no fabricated CSV success or wait for future metrics.
- [ ] Verify existing completed private upload remains complete/private and document actual live boundaries.
