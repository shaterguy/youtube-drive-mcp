# YouTube Drive MCP

Main-account Google Drive → separately authorized YouTube channel, hosted on Vercel.

Version: `0.1.0-dev2` · Node 24 · MCP endpoint: `https://youtube-drive-mcp.vercel.app/mcp`

## ChatGPT web and mobile connection

Create the hosted connection in **ChatGPT Plugins → + → Add custom MCP server**. Use the endpoint above, choose **OAuth**, and retain the discovered **CIMD** client registration. Set required scopes to `openid` and `offline_access`; keep `drive:read`, `youtube:read`, `youtube:write`, and `uploads:write` as the default tool scopes. Complete account authorization, then use the resulting App-backed plugin in a new ChatGPT conversation.

The `plugin/` folder is a portable MCP package for compatible Codex hosts. Uploading it through Plugin Creator alone can produce a **Desktop only** plugin; it does not register the hosted App required by ChatGPT web. Use the custom MCP connection flow for web use. Mobile availability must be checked on the same account after the hosted connection is installed and authorized. No desktop application or local MCP process is required by this Vercel server.

## Accounts and authorization

Only the verified `OWNER_EMAIL` Google identity can sign in to this MCP. The login requests basic identity scopes. It does not link or replace the separately authorized channel account.

After signing in at `/connect`, connect Google Drive with the main account and YouTube with the channel-owning account. The service confirms that the channel account's `mine=true` result includes `YOUTUBE_CHANNEL_ID` before saving that connection. Drive receives `drive.readonly`; YouTube receives `youtube.upload` and `youtube.force-ssl`.

Create two separate Google OAuth web clients for the two workflows. The standard interactive client handles only the main account's login identity. Create a distinct client with Google's **Use this client for an AI-powered agent** setting enabled for MCP/automated API access. Do not reuse one client ID for both workflows.

- Standard interactive client (`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`): register `https://youtube-drive-mcp.vercel.app/api/auth/callback/google`.
- Agent API client (`GOOGLE_AGENT_CLIENT_ID` / `GOOGLE_AGENT_CLIENT_SECRET`): register `https://youtube-drive-mcp.vercel.app/google/callback`.

Drive and YouTube both use the agent client, while retaining separate main-account and channel-account tokens in the vault. Agent authorization, code exchange, ID-token audience verification and refresh all use only the agent credentials. Configuration rejects identical interactive/agent client IDs.

Enable Google Drive API and YouTube Data API v3 on this OAuth client's Google Cloud project. Use an **In production** Google OAuth audience for ongoing access. Google's Testing audience may issue grants that expire after seven days. A time-based grant expiry is retained and displayed when Google supplies it.

Public Google OAuth branding pages are available without signing in: homepage `/`, privacy information `/privacy`, and service terms `/terms`. They describe the implemented account separation, encrypted credential/job storage and memory-only video transfer; account-specific connection status remains behind login.

## Connection continuity

MCP OAuth grants, rotating refresh tokens and signing keys live in Postgres. Google service tokens live in a separate AES-256-GCM vault with owner/provider/purpose binding. Keep the database and encryption/authentication secrets unchanged across deployments.

Google access tokens refresh under a database row lock five minutes before expiry. A refresh response that omits `refresh_token` preserves the existing refresh token. Concurrent rejected access tokens reuse an already refreshed token. A 401 permits one forced refresh; quota and temporary errors retain the credential state. `invalid_grant` marks only that Google service as needing authorization. Reconnect that service at `/connect`; the MCP grant and upload jobs remain.

MCP access tokens last five minutes; refresh tokens rotate with a rolling 365-day lifetime and a 30-second lost-response recovery window. Clients must request `offline_access`. These grants survive expiry/deletion of the browser login session, including the library's logout hook. A user-revoked grant, Google account restriction, explicit OAuth disconnect, prolonged inactivity beyond the refresh lifetime, or encryption-key loss still requires recovery. The application does not promise to override Google revocation.

## Video transfer

`upload_drive_video` accepts a Drive file ID, a stable idempotency key, metadata and an explicit privacy status. The service reads the main account's private Drive and sends bytes with the **separate YouTube credential**. No public file sharing or video bytes in ChatGPT are required.

A job freezes the Drive version, revision, checksum and size. Each step transfers at most 8 MiB. Its resumable session URI is encrypted and committed before the first video byte. Each continuation probes that same session; a final response lost after YouTube accepted the bytes is recovered without another upload. The database serializes one owner's active transfers with a nonblocking advisory lock. Parallel callers receive `UPLOAD_BUSY_RETRY_SAME_JOB` and should retry the same job, rather than create a new one.

The MCP tool advances bounded batches and returns `continuation: {tool: "upload_advance", arguments: {jobId}}` until complete. The caller should keep invoking that continuation. If a batch fails, its MCP error result retains the same job ID and latest readable progress. Transient failures return `retrySameJob: true` and the continuation; source changes, expired or uncertain sessions and authorization failures return no automatic continuation. Upload status probes accept Google's 308 response without following its Location header. `/connect` also provides a single-start browser form that automatically advances chunks while the page remains open. Closing it pauses further requests; the same job ID resumes the saved upload.

A changed source, expired upload session or uncertain initialization stops for attention instead of silently creating a second upload. A completed job returns the YouTube video ID. YouTube processing/visibility is separately readable with `youtube_get_video`; receiving all bytes is not a claim that processing has finished.

Tools also support bounded Drive text/metadata reads, channel videos and playlists, explicit video metadata/privacy/schedule changes, Drive thumbnails, and playlist membership. Writes verify that the video/playlist belongs to the pinned channel. Video updates send only changed parts and preserve mutable settings within those parts.

## Deployment

Create a **dedicated database**; do not point this service at another application's existing auth database. Set the following production environment variables in the deployment platform's secret/config store:

| Variable | Value or format |
| --- | --- |
| `PUBLIC_ORIGIN` | `https://youtube-drive-mcp.vercel.app` |
| `OWNER_EMAIL` | `shaterguy@gmail.com` |
| `YOUTUBE_CHANNEL_ID` | `UCrTwN67Kw-1cX8BKGbryQag` |
| `DATABASE_URL` | Postgres URL with `sslmode=require` or `verify-full` |
| `BETTER_AUTH_SECRET` | Stable cryptographic secret, at least 32 bytes |
| `TOKEN_ENCRYPTION_KEY` | Stable 32 random bytes encoded as base64url (43 characters) |
| `GOOGLE_CLIENT_ID` | Standard interactive web OAuth client ID, used only for login identity |
| `GOOGLE_CLIENT_SECRET` | Matching standard interactive client secret |
| `GOOGLE_AGENT_CLIENT_ID` | Separate agent-enabled web OAuth client ID for automated Drive/YouTube access |
| `GOOGLE_AGENT_CLIENT_SECRET` | Matching agent client secret |

Apply `sql/auth.sql` once and `sql/app.sql`, or run `npm run migrate` in the authorized deployment environment. The script applies the auth schema only when its `user` table does not exist. Never write real credentials into source, local examples, logs or test fixtures.

`npm ci --ignore-scripts`, `npm test`, `npm run typecheck`, and `npm run build` are the reproducible verification commands. The optional emergency workflow runs on manual dispatch or a `ci-fallback/**` product branch and needs no production secrets. Ordinary pushes/PRs do not run GitHub Actions.

## Verification boundary

Secret-free fixtures exercise actual provider-role Authorization header injection, encrypted credentials, simultaneous refresh/401 handling, source pinning, resumable progress, lost final response recovery and the actual Better Auth refresh/logout path. PGlite fixtures replace advisory-lock acquisition because they are not a multi-connection Postgres deployment; production lock behavior requires a separate Postgres integration check. Live Google account approvals, target channel access and a real upload are deployment checks, not implied by fixture success.

## Channel analytics and bulk reports

At `/connect`, optionally add `youtube.readonly` and `yt-analytics.readonly` to the existing channel grant using the targeted analytics consent control. Enable YouTube Analytics API and YouTube Reporting API in the same agent OAuth project. Ordinary YouTube reconnection keeps its existing scopes. Missing analytics permission returns ANALYTICS_AUTH_REQUIRED without changing upload credentials or MCP authorization; partial or wrong-subject reconsent leaves the previous credential intact. An expanded connection stays bound to that Google subject and the configured channel.

youtube_analytics_report offers server-selected summary, daily, videos, traffic and single-video retention profiles with ordered ISO dates (at most 367 reporting days). All queries verify the current credential's pinned channel. Pacific reporting days are distinct from KST days. Sparse daily rows identify observed available dates; profiles without a day dimension report unknown data-through. Empty responses do not fabricate totals. Retention returns original provider bins; it does not derive an exact 30-second value.

Reporting tools discover currently available reach, end-screen and card report types, list jobs and reports, explicitly enable a selected type after checking existing jobs, and read a selected report as parsed CSV. Reads use youtube:read; enabling requires existing youtube:write. A Postgres advisory lock serializes enablement per owner/type and retries list Google jobs before creating. No scheduler or database schema is added; Google retains job identities and generates reports asynchronously. First reports may be pending. A matching expired job is returned with state expired, enabled=false and an instruction to select a currently supported replacement type; it is never silently recreated.

Authenticated /connect controls and JSON POST routes /ui/analytics-status, /ui/analytics-report, /ui/reporting-types, /ui/reporting-jobs, /ui/reporting-enable, /ui/reporting-reports and /ui/reporting-csv invoke these same methods with session and same-origin protections. /ui/analytics-consent starts targeted consent. These also support web/mobile use when a client caches earlier MCP tool discovery.

Analytics results and CSV responses are processed in memory, returned only to the authorized requester and not persisted by the service. Reporting metadata is verified with the current channel credential; download URLs and tokens are never returned. Downloads accept only the verified Google channel/job/report media path, reject redirects, reject content larger than 1 MiB and malformed CSV/UTF-8, and return at most 500 rows (default 100). A row-limited sample explicitly says partial and contains no calculated totals or rates. Provider data and CSV cells remain untrusted content.
