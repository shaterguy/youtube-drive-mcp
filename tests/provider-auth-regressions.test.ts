import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import type {Pool} from 'pg';
import {OAuth2Client} from 'google-auth-library';
import {Providers} from '../src/providers.ts';
import {Analytics} from '../src/analytics.ts';
import {ANALYTICS_SCOPES,PROVIDER_SCOPES} from '../src/config.ts';
import {googleError} from '../src/http.ts';
import {config} from './fixtures.ts';

const base=[...PROVIDER_SCOPES.youtube],all=[...base,...ANALYTICS_SCOPES];
async function fixture(fetcher:typeof fetch){
 const db=new PGlite();
 for(const file of ['../sql/auth.sql','../sql/app.sql'])await db.exec(await readFile(new URL(file,import.meta.url),'utf8'));
 await db.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true)',['owner','Fixture',config.ownerEmail]);
 const query=(sql:string,values?:unknown[])=>db.query(sql,values);
 const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool;
 const providers=new Providers(pool,config,fetcher),ctx=providers.context('owner','youtube');
 await query(`INSERT INTO provider_connections(owner_id,provider,subject,email,scopes,access_cipher,refresh_cipher,expires_at,channel_id) VALUES($1,'youtube',$2,$3,$4,$5,$6,$7,$8)`,['owner','channel-sub','channel@example.com',JSON.stringify(all),providers.cipher.seal('old-access',ctx),providers.cipher.seal('old-refresh',ctx),new Date(Date.now()-1000),config.youtubeChannelId]);
 return {db,pool,providers,analytics:new Analytics(providers,'owner')};
}

test('explicit refresh scope reduction updates readiness and preserves base YouTube access',async()=>{
 let apiCalls=0;
 const f=await fixture(async target=>{
  if(String(target).includes('oauth2.googleapis.com'))return Response.json({access_token:'new-access',expires_in:3600,scope:base.join(' ')});
  apiCalls++;return Response.json({items:[{id:config.youtubeChannelId}]});
 });
 try{
  await assert.rejects(f.analytics.report({profile:'summary',startDate:'2026-10-01',endDate:'2026-10-02'}),{code:'ANALYTICS_AUTH_REQUIRED'});
  assert.equal(apiCalls,0);
  const row=await f.providers.connection('owner','youtube');assert.deepEqual(row.scopes,base);assert.equal(row.auth_state,'active');
  const status=await f.analytics.status();assert.equal(status.ready,false);assert.deepEqual(status.missingScopes,[...ANALYTICS_SCOPES]);
  assert.equal((await f.providers.request('owner','youtube','https://www.googleapis.com/youtube/v3/channels?mine=true')).status,200);
 }finally{await f.db.close();}
});

test('omitted refresh scope preserves consent and malformed scope cannot overwrite credentials',async()=>{
 for(const mode of ['omitted','malformed','empty'] as const){
  const response={access_token:'new-access',expires_in:3600,...(mode==='omitted'?{}:{scope:mode==='empty'?'':123})};
  const f=await fixture(async()=>Response.json(response));
  try{
   if(mode==='malformed')await assert.rejects(f.providers.token('owner','youtube'),{code:'GOOGLE_TEMPORARILY_UNAVAILABLE'});
   else assert.equal(await f.providers.token('owner','youtube'),'new-access');
   const row=await f.providers.connection('owner','youtube');
   assert.deepEqual(row.scopes,mode==='empty'?[]:all);
   assert.equal(f.providers.cipher.open(row.access_cipher,f.providers.context('owner','youtube')),mode==='malformed'?'old-access':'new-access');
  }finally{await f.db.close();}
 }
});

test('regular reconnect can drop optional analytics but cannot change an existing YouTube subject',async t=>{
 let payload:{sub:string;nonce:string;email:string;email_verified:boolean};
 t.mock.method(OAuth2Client.prototype,'getToken',async()=>({tokens:{id_token:'fixture-id',access_token:'new-access',refresh_token:'new-refresh',expiry_date:Date.now()+3600000,scope:base.join(' ')}}) as any);
 t.mock.method(OAuth2Client.prototype,'verifyIdToken',async()=>({getPayload:()=>payload}) as any);
 for(const subject of ['channel-sub','different-sub']){
  const f=await fixture(async()=>Response.json({items:[{id:config.youtubeChannelId}]}));
  try{
   const url=new URL(await f.providers.begin('owner','session','youtube'));
   assert.deepEqual(url.searchParams.get('scope')!.split(' '),base);
   const state=(await f.pool.query('SELECT nonce FROM provider_states')).rows[0];
   payload={sub:subject,nonce:state.nonce,email:'channel@example.com',email_verified:true};
   if(subject==='different-sub')await assert.rejects(f.providers.complete('owner','session',url.searchParams.get('state')!,'fixture-code'),{code:'YOUTUBE_SUBJECT_MISMATCH'});
   else{assert.equal(await f.providers.complete('owner','session',url.searchParams.get('state')!,'fixture-code'),'youtube');assert.deepEqual((await f.providers.connection('owner','youtube')).scopes,base);}
  }finally{await f.db.close();}
 }
});

test('Google 403 reasons distinguish missing scopes, project configuration and unknown denial without leaking the body',async()=>{
 for(const [reason,code] of [['insufficientPermissions','GOOGLE_INSUFFICIENT_SCOPE'],['accessNotConfigured','GOOGLE_API_CONFIGURATION_REQUIRED'],['forbidden','GOOGLE_PERMISSION_DENIED'],['private-unrecognized-reason','GOOGLE_FORBIDDEN_UNKNOWN']] as const){
  await assert.rejects(googleError(Response.json({error:{errors:[{reason}],message:'private-response-must-not-leak'}},{status:403})),error=>{assert.equal((error as any).code,code);assert.doesNotMatch(String(error),/private-response|private-unrecognized/);return true;});
 }
 await assert.rejects(googleError(Response.json({error:{status:'PERMISSION_DENIED',details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason:'SERVICE_DISABLED'}]}},{status:403})),{code:'GOOGLE_API_CONFIGURATION_REQUIRED'});
 await assert.rejects(googleError(Response.json({error:{status:'PERMISSION_DENIED',details:[{'@type':'type.googleapis.com/google.rpc.ErrorInfo',reason:'ACCESS_TOKEN_SCOPE_INSUFFICIENT'}]}},{status:403})),{code:'GOOGLE_INSUFFICIENT_SCOPE'});
 await assert.rejects(googleError(Response.json({error:{errors:[{reason:'insufficientPermissions'},{reason:'forbidden'}]}},{status:403})),{code:'GOOGLE_FORBIDDEN_UNKNOWN'});
 await assert.rejects(googleError(Response.json({error:{errors:[{reason:'quotaExceeded'}]}},{status:403})),{code:'GOOGLE_QUOTA_OR_RATE_LIMIT'});
});

test('analytics requests reconsent only for actual missing scopes, not API setup or generic forbidden responses',async()=>{
 for(const [reason,code] of [['insufficientPermissions','ANALYTICS_AUTH_REQUIRED'],['accessNotConfigured','GOOGLE_API_CONFIGURATION_REQUIRED'],['forbidden','GOOGLE_PERMISSION_DENIED'],['unrecognized','GOOGLE_FORBIDDEN_UNKNOWN']] as const){
  const f=await fixture(async target=>String(target).includes('oauth2.googleapis.com')?Response.json({access_token:'new-access',expires_in:3600}):String(target).includes('/youtube/v3/channels')?Response.json({items:[{id:config.youtubeChannelId}]}):Response.json({error:{errors:[{reason}]}},{status:403}));
  try{await assert.rejects(f.analytics.report({profile:'summary',startDate:'2026-10-01',endDate:'2026-10-02'}),{code});assert.equal((await f.providers.connection('owner','youtube')).auth_state,'active');}
  finally{await f.db.close();}
 }
});
