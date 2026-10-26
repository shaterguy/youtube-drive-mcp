CREATE TABLE IF NOT EXISTS provider_connections (
 owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 provider TEXT NOT NULL CHECK(provider IN ('drive','youtube')),
 subject TEXT NOT NULL, email TEXT NOT NULL, scopes JSONB NOT NULL,
 access_cipher TEXT NOT NULL, refresh_cipher TEXT NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL, refresh_expires_at TIMESTAMPTZ,
 channel_id TEXT, channel_title TEXT, channel_uploads TEXT,
 auth_state TEXT NOT NULL DEFAULT 'active' CHECK(auth_state IN ('active','reauth_required')),
 last_refresh_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(owner_id,provider)
);
CREATE TABLE IF NOT EXISTS provider_states (
 state_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 session_id TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('drive','youtube')),
 verifier_cipher TEXT NOT NULL, nonce TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS upload_jobs (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 idempotency_key TEXT NOT NULL, request_hash TEXT NOT NULL,
 drive_file_id TEXT NOT NULL, source_version TEXT NOT NULL, source_revision TEXT NOT NULL, source_md5 TEXT,
 source_size BIGINT NOT NULL CHECK(source_size>0), mime_type TEXT NOT NULL,
 channel_id TEXT NOT NULL, metadata JSONB NOT NULL,
 session_cipher TEXT, offset_bytes BIGINT NOT NULL DEFAULT 0 CHECK(offset_bytes>=0),
 status TEXT NOT NULL CHECK(status IN ('created','uploading','complete','session_expired','source_changed','initialization_uncertain')),
 video_id TEXT, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(owner_id,idempotency_key)
);
