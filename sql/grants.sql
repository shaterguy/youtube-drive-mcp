-- Additive, repeatable migration. Existing consent keeps its legacy JWTs until
-- the next explicit revocation/new authorization. Google credentials are untouched.
CREATE TABLE IF NOT EXISTS mcp_grants (
 owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 client_id TEXT NOT NULL REFERENCES "oauthClient"("clientId") ON DELETE CASCADE,
 grant_id TEXT NOT NULL UNIQUE,
 revoked_at TIMESTAMPTZ,
 legacy_allowed BOOLEAN NOT NULL DEFAULT false,
 PRIMARY KEY(owner_id,client_id)
);
-- Consent also covers a rotation between the parent's update and child's insert.
-- A seed never restores a revoked refresh token: the maintained provider rejects it.
INSERT INTO mcp_grants(owner_id,client_id,grant_id,legacy_allowed)
 SELECT DISTINCT "userId","clientId",gen_random_uuid()::text,true
 FROM "oauthConsent" WHERE "referenceId"="userId"
 ON CONFLICT(owner_id,client_id) DO NOTHING;

CREATE OR REPLACE FUNCTION ydmcp_revoke_grant(u TEXT,c TEXT) RETURNS VOID LANGUAGE SQL AS $$
 UPDATE mcp_grants SET revoked_at=COALESCE(revoked_at,now()),legacy_allowed=false
 WHERE owner_id=u AND client_id=c;
$$;
CREATE OR REPLACE FUNCTION ydmcp_consent_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  PERFORM ydmcp_revoke_grant(OLD."userId",OLD."clientId"); RETURN OLD;
 END IF;
 IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
  OR NEW."referenceId" IS DISTINCT FROM OLD."referenceId"
  OR NOT (COALESCE(NEW.scopes,'[]'::jsonb) @> COALESCE(OLD.scopes,'[]'::jsonb))
  OR NOT (COALESCE(NEW.resources,'[]'::jsonb) @> COALESCE(OLD.resources,'[]'::jsonb)) THEN
  PERFORM ydmcp_revoke_grant(OLD."userId",OLD."clientId");
 END IF;
 RETURN NEW;
END; $$;
CREATE OR REPLACE TRIGGER ydmcp_consent_delete AFTER DELETE ON "oauthConsent"
 FOR EACH ROW EXECUTE FUNCTION ydmcp_consent_changed();
CREATE OR REPLACE TRIGGER ydmcp_consent_update AFTER UPDATE ON "oauthConsent"
 FOR EACH ROW EXECUTE FUNCTION ydmcp_consent_changed();

CREATE OR REPLACE FUNCTION ydmcp_refresh_changed() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD."expiresAt">now() THEN PERFORM ydmcp_revoke_grant(OLD."userId",OLD."clientId"); END IF;
  RETURN OLD;
 END IF;
 IF NEW.revoked IS NOT NULL AND OLD.revoked IS NULL AND NEW."rotatedAt" IS NULL THEN
  PERFORM ydmcp_revoke_grant(NEW."userId",NEW."clientId");
 END IF;
 RETURN NEW;
END; $$;
CREATE OR REPLACE TRIGGER ydmcp_refresh_revoke AFTER UPDATE OF revoked ON "oauthRefreshToken"
 FOR EACH ROW EXECUTE FUNCTION ydmcp_refresh_changed();
CREATE OR REPLACE TRIGGER ydmcp_refresh_delete AFTER DELETE ON "oauthRefreshToken"
 FOR EACH ROW EXECUTE FUNCTION ydmcp_refresh_changed();
CREATE OR REPLACE FUNCTION ydmcp_require_active_grant() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 PERFORM 1 FROM mcp_grants WHERE owner_id=NEW."userId" AND client_id=NEW."clientId"
  AND revoked_at IS NULL FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'MCP_GRANT_REVOKED'; END IF;
 RETURN NEW;
END; $$;
CREATE OR REPLACE TRIGGER ydmcp_refresh_insert BEFORE INSERT ON "oauthRefreshToken"
 FOR EACH ROW EXECUTE FUNCTION ydmcp_require_active_grant();
