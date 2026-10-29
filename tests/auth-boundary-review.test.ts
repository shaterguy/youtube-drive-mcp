import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {ownerFromClaims} from '../src/auth.ts';
import {GRANT_CLAIM} from '../src/grants.ts';
import {config} from './fixtures.ts';
import {mcpAuthFixture} from './mcp-auth-fixture.ts';

test('repeated migration preserves the current grant and never reactivates an explicit tombstone',async t=>{
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('UNEXPECTED_FIXTURE_NETWORK');});
 const f=await mcpAuthFixture();
 try{
  const migration=await readFile(new URL('../sql/grants.sql',import.meta.url),'utf8');
  const before=(await f.query('SELECT grant_id FROM mcp_grants')).rows[0]!.grant_id;
  await f.db.exec(migration);await f.db.exec(migration);
  assert.equal((await f.query('SELECT grant_id FROM mcp_grants')).rows[0]!.grant_id,before);
  assert.equal((await f.owner(f.legacyAccess)).id,f.userId);
  const pair=await f.rotate();
  assert.equal((await f.post('/oauth2/revoke',{client_id:f.clientId,token:pair.refresh_token,token_type_hint:'refresh_token'})).status,200);
  const revoked=(await f.query('SELECT grant_id,revoked_at,legacy_allowed FROM mcp_grants')).rows[0]!;
  await f.db.exec(migration);await f.db.exec(migration);
  const after=(await f.query('SELECT grant_id,revoked_at,legacy_allowed FROM mcp_grants')).rows[0]!;
  assert.deepEqual(after,revoked);assert.equal(after.legacy_allowed,false);
  await assert.rejects(f.owner(pair.access_token),{code:'AUTH_REQUIRED'});
  await assert.rejects(f.owner(f.legacyAccess),{code:'AUTH_REQUIRED'});
  assert.notEqual((await f.refresh(pair.refresh_token)).status,200);
 }finally{await f.close();}
});

test('equivalent consent updates preserve access but resource removal cannot be undone to revive old tokens',async t=>{
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('UNEXPECTED_FIXTURE_NETWORK');});
 const f=await mcpAuthFixture();
 try{
  const pair=await f.rotate();
  await f.query('UPDATE "oauthConsent" SET scopes=scopes,resources=resources WHERE id=$1',[f.consentId]);
  assert.equal((await f.owner(pair.access_token)).id,f.userId);
  await f.query('UPDATE "oauthConsent" SET resources=$2 WHERE id=$1',[f.consentId,JSON.stringify([])]);
  await f.query('UPDATE "oauthConsent" SET resources=$2 WHERE id=$1',[f.consentId,JSON.stringify([config.resource])]);
  await assert.rejects(f.owner(pair.access_token),{code:'AUTH_REQUIRED'});
  assert.notEqual((await f.refresh(pair.refresh_token)).status,200);
  const fresh=await f.authorize();assert.equal((await f.owner(fresh.access_token)).id,f.userId);
  await assert.rejects(f.owner(pair.access_token),{code:'AUTH_REQUIRED'});
 }finally{await f.close();}
});

test('expired rotated-parent cleanup does not revoke the newer active refresh generation',async t=>{
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('UNEXPECTED_FIXTURE_NETWORK');});
 const f=await mcpAuthFixture();
 try{
  const pair=await f.rotate();
  await f.query('UPDATE "oauthRefreshToken" SET "expiresAt"=now()-interval \'1 second\' WHERE revoked IS NOT NULL');
  await f.query('DELETE FROM "oauthRefreshToken" WHERE "expiresAt"<now()');
  assert.equal((await f.owner(pair.access_token)).id,f.userId);
  const next=await f.rotate(pair.refresh_token);assert.equal((await f.owner(next.access_token)).id,f.userId);
 }finally{await f.close();}
});

test('disabled clients and mismatched owner, audience, scope or grant stay denied at the app boundary',async t=>{
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('UNEXPECTED_FIXTURE_NETWORK');});
 const f=await mcpAuthFixture();
 try{
  const pair=await f.rotate(),claims=await f.claims(pair.access_token);
  for(const change of [
   {sub:'different-owner'},
   {aud:config.origin+'/other-resource'},
   {scope:String(claims.scope)+' unsupported:write'},
   {[GRANT_CLAIM]:null},
   {[GRANT_CLAIM]:'different-grant'},
   {exp:0},
  ])await assert.rejects(ownerFromClaims(f.pool,config,{...claims,...change}),{code:'AUTH_REQUIRED'});
  await f.query('UPDATE "oauthClient" SET disabled=true WHERE "clientId"=$1',[f.clientId]);
  await assert.rejects(f.owner(pair.access_token),{code:'AUTH_REQUIRED'});
  assert.notEqual((await f.refresh(pair.refresh_token)).status,200);
 }finally{await f.close();}
});
