import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAuthHandler} from '../src/auth-handler.ts';
import {ownerFromClaims} from '../src/auth.ts';
import {GRANT_CLAIM} from '../src/grants.ts';
import {config} from './fixtures.ts';
import {mcpAuthFixture,grantedScopes} from './mcp-auth-fixture.ts';

test('migration preserves existing connection and explicit revoke immediately blocks legacy and current JWTs',async t=>{
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('UNEXPECTED_FIXTURE_NETWORK');});
 const f=await mcpAuthFixture();
 try{
  assert.equal((await f.owner(f.legacyAccess)).id,f.userId);
  const first=await f.rotate();assert.equal((await f.owner(first.access_token)).id,f.userId);
  const before=await f.claims(first.access_token);assert.equal(typeof before[GRANT_CLAIM],'string');
  const revoke=await f.post('/oauth2/revoke',{client_id:f.clientId,token:first.refresh_token,token_type_hint:'refresh_token'});assert.equal(revoke.status,200);
  assert.notEqual((await f.refresh(first.refresh_token)).status,200);
  await assert.rejects(f.owner(first.access_token),{code:'AUTH_REQUIRED'});
  await assert.rejects(f.owner(f.legacyAccess),{code:'AUTH_REQUIRED'});
  const second=await f.authorize();assert.equal((await f.owner(second.access_token)).id,f.userId);
  const after=await f.claims(second.access_token);assert.notEqual(after[GRANT_CLAIM],before[GRANT_CLAIM]);
  await assert.rejects(f.owner(first.access_token),{code:'AUTH_REQUIRED'});await assert.rejects(f.owner(f.legacyAccess),{code:'AUTH_REQUIRED'});
  assert.notEqual((await f.refresh(first.refresh_token)).status,200);assert.notEqual((await f.refresh(f.initialRefresh)).status,200);
  assert.equal((await f.refresh(second.refresh_token)).status,200);
 }finally{await f.close();}
});

test('same-token overlapping refreshes across auth handler instances return the same maintained replay pair',async t=>{
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('UNEXPECTED_FIXTURE_NETWORK');});
 const f=await mcpAuthFixture();
 try{
  const independent=createAuthHandler(f.pool,f.auth.handler);
  const responses=await Promise.all([f.refresh(),f.refresh(f.initialRefresh,{},independent)]);
  assert.deepEqual(responses.map(response=>response.status),[200,200]);
  const [a,b]=await Promise.all(responses.map(response=>response.json()));
  assert.equal(a.refresh_token,b.refresh_token);assert.equal(a.access_token,b.access_token);assert.equal(f.peakGates(),1);
  assert.equal((await f.owner(a.access_token)).id,f.userId);
  assert.equal((await f.refresh(a.refresh_token)).status,200);
 }finally{await f.close();}
});

test('consent deletion, scope reduction and client mismatch deny access without reviving an old generation',async t=>{
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('UNEXPECTED_FIXTURE_NETWORK');});
 for(const mode of ['delete','reduce'] as const){
  const f=await mcpAuthFixture();
  try{
   const pair=await f.rotate(),claims=await f.claims(pair.access_token);
   await assert.rejects(ownerFromClaims(f.pool,config,{...claims,client_id:'other-client',azp:'other-client'}),{code:'AUTH_REQUIRED'});
   assert.notEqual((await f.refresh(pair.refresh_token,{client_id:'other-client'})).status,200);
   assert.equal((await f.owner(pair.access_token)).id,f.userId);
   if(mode==='delete')await f.query('DELETE FROM "oauthConsent" WHERE id=$1',[f.consentId]);
   else await f.query('UPDATE "oauthConsent" SET scopes=$2 WHERE id=$1',[f.consentId,JSON.stringify(grantedScopes.filter(scope=>scope!=='youtube:write'))]);
   await assert.rejects(f.owner(pair.access_token),{code:'AUTH_REQUIRED'});assert.notEqual((await f.refresh(pair.refresh_token)).status,200);
   const next=await f.authorize();assert.equal((await f.owner(next.access_token)).id,f.userId);
   await assert.rejects(f.owner(pair.access_token),{code:'AUTH_REQUIRED'});assert.notEqual((await f.refresh(pair.refresh_token)).status,200);
  }finally{await f.close();}
 }
});
