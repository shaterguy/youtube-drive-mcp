# YouTube Drive MCP

Main-account Google Drive → separately authorized YouTube channel, hosted on Vercel.

Version: `0.1.0-dev1` · Node 24 · MCP endpoint: `https://youtube-drive-mcp.vercel.app/mcp`

## Accounts and authorization

Only the verified `OWNER_EMAIL` Google identity can sign in to this MCP. The login requests basic identity scopes. It does not link or replace the separately authorized channel account.

After signing in at `/connect`, connect Google Drive with the main account and YouTube with the channel-owning account. The service confirms that the channel account's `mine=true` result includes `YOUTUBE_CHANNEL_ID` before saving that connection. Drive receives `drive.readonly`; YouTube receives `youtube.upload` and `youtube.force-ssl`.

Google OAuth callbacks to register on the application's web OAuth client:

- `https://youtube-drive-mcp.vercel.app/api/auth/callback/google`
- `https://youtube-drive-mcp.vercel.app/google/callback`

Enable Google Drive API and YouTube Data API v3 on this OAuth client's Google Cloud project. Use an **In production** Google OAuth audience for ongoing access. Google's Testing audience may issue grants that expire after seven days. A time-based grant expiry is retained and displayed when Google supplies it.

Public Google OAuth branding pages are available without signing in: homepage `/`, privacy information `/privacy`, and service terms `/terms`. They describe the implemented account separation, encrypted credential/job storage and memory-only video transfer; account-specific connection status remains behind login.

## Connection continuity

MCP OAuth grants, rotating refresh tokens and signing keys live in Postgres. Google service tokens live in a separate AES-256-GCM vault with owner/provider/purpose binding. Keep the database and encryption/authentication secrets unchanged across deployments.

Google access tokens refresh under a database row lock five minutes before expiry. A refresh response that omits `refresh_token` preserves the existing refresh token. Concurrent rejected access tokens reuse an already refreshed token. A 401 permits one forced refresh; quota and temporary errors retain the credential state. `invalid_grant` marks only that Google service as needing authorization. Reconnect that service at `/connect`; the MCP grant and upload jobs remain.

MCP access tokens last five minutes; refresh tokens rotate with a rolling 365-day lifetime and a 30-second lost-response recovery window. Clients must request `offline_access`. These grants survive expiry/deletion of the browser login session, including the library's logout hook. A user-revoked grant, Google account restriction, explicit OAuth disconnect, prolonged inactivity beyond the refresh lifetime, or encryption-key loss still requires recovery. The application does not promise to override Google revocation.

## Video transfer

`upload_drive_video` accepts a Drive file ID, a stable idempotency key, metadata and an explicit privacy status. The service reads the main account's private Drive and sends bytes with the **separate YouTube credential**. No public file sharing or video bytes in ChatGPT are required.

A job freezes the Drive version, revision, checksum and size. Each step transfers at most 8 MiB. Its resumable session URI is encrypted and committed before the first video byte. Each continuation probes that same session; a final response lost after YouTube accepted the bytes is recovered without another upload. The database serializes one owner's active transfers with a nonblocking advisory lock. Parallel callers receive `UPLOAD_BUSY_RETRY_SAME_JOB` and should retry the same job, rather than create a new one.

The MCP tool advances bounded batches and returns `continuation: {tool: "upload_advance", arguments: {jobId}}` until complete. The caller should keep invoking that continuation. `/connect` also provides a single-start browser form that automatically advances chunks while the page remains open. Closing it pauses further requests; the same job ID resumes the saved upload.

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
| `GOOGLE_CLIENT_ID` | Web OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Matching web OAuth client secret |

Apply `sql/auth.sql` once and `sql/app.sql`, or run `npm run migrate` in the authorized deployment environment. The script applies the auth schema only when its `user` table does not exist. Never write real credentials into source, local examples, logs or test fixtures.

`npm ci --ignore-scripts`, `npm test`, `npm run typecheck`, and `npm run build` are the reproducible verification commands. The optional emergency workflow runs on manual dispatch or a `ci-fallback/**` product branch and needs no production secrets. Ordinary pushes/PRs do not run GitHub Actions.

## Verification boundary

Secret-free fixtures exercise actual provider-role Authorization header injection, encrypted credentials, simultaneous refresh/401 handling, source pinning, resumable progress, lost final response recovery and the actual Better Auth refresh/logout path. PGlite fixtures replace advisory-lock acquisition because they are not a multi-connection Postgres deployment; production lock behavior requires a separate Postgres integration check. Live Google account approvals, target channel access and a real upload are deployment checks, not implied by fixture success.
