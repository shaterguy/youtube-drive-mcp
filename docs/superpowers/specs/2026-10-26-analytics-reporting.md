# Analytics and Reporting integration
Approved proposal: extend the existing YouTube Drive MCP with YouTube Analytics API and YouTube Reporting API. Current user instruction: "반영해".
Baseline: 517a8c75cd8c7047e65823dc39ac2904b287e800; current production https://youtube-drive-mcp.vercel.app.
Target: v0.1.0-dev2. Preserve main-owner MCP login, main Drive credential, separately pinned channel credential, existing uploads and encryption keys.
AC-01: youtube_analytics_report exposes server-selected summary, daily, videos, traffic and single-video retention profiles with strict ISO calendar dates and pinned channel. No arbitrary URL/metrics/channel inputs.
AC-02: Existing Google YouTube grant may be expanded by incremental consent with youtube.readonly and yt-analytics.readonly. Existing upload operations remain usable before consent. Missing analytics scopes produce ANALYTICS_AUTH_REQUIRED without changing connection auth_state.
AC-03: Reporting report-type discovery, same-channel job listing and idempotent enablement for current supported reach/end-screen/card report types. Do not create duplicate jobs or new cron/daemon/ChatGPT automations.
AC-04: List reports and retrieve a selected provider-owned report CSV through its verified job/report identity. Validate exact HTTPS Google download host/path, do not follow redirects, never expose bearer headers or signed download URLs. Bounded CSV parsing handles quotes/newlines/BOM, row limits and explicit truncation; never label partial rows as a complete aggregate.
AC-05: Return source, source timezone, requested period, available dates/period, captured time and empty/pending distinctions. Pacific reporting days are not KST calendar days. Retention returns original 100 bins; do not fabricate exact 30-second values.
AC-06: Authenticated owner UI supports analytics status/consent and same-service report operations for web/mobile use and live verification. Same-origin/session protections remain.
SAFE-01: Scopes and fixed provider endpoints only; no generic proxy. Provider account and pinned channel checks before reads/writes. No secrets, account tokens, private channel data or strategy in public source/docs.
REL-01: Unit/integration tests, typecheck/build, independent functional and security review, exact source on GitHub, same Vercel service deployment and actual authorized Analytics query/reportTypes/job readback.
Out of scope: monetary analytics, arbitrary channel access, Studio real-time graphs, editing end screens/cards, public video edits, new upload of the completed private test, dashboard, scheduled polling services.
Official references:
https://developers.google.com/youtube/analytics/reference/reports/query
https://developers.google.com/youtube/analytics/channel_reports
https://developers.google.com/youtube/reporting/v1/reports/channel_reports
https://developers.google.com/youtube/reporting/v1/reference/rest/v1/reportTypes/list
https://developers.google.com/youtube/reporting/v1/reports
