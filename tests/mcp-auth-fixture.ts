import {readFile} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {PGlite} from '@electric-sql/pglite';
import {PostgresDialect} from 'kysely';
import {betterAuth} from 'better-auth';
import {importJWK,jwtVerify} from 'jose';
import type {Pool} from 'pg';
import {authOptions,ownerFromClaims} from '../src/auth.ts';
import {createAuthHandler} from '../src/auth-handler.ts';
import {AppError} from '../src/config.ts';
import {config} from './fixtures.ts';

export const grantedScopes=['offline_access','drive:read','youtube:read','youtube:write','uploads:write'];
const hash=(value:string)=>createHash('sha256').update(value).digest('base64url');

/** PGlite has one connection and no advisory locks. Only the auth gate's control
 * transaction is emulated; all grant queries, foreign keys and revocation
 * triggers execute in PostgreSQL. Ordinary data transactions remain real.
 */
export async function mcpAuthFixture(){
 const db=new PGlite();
 for(const file of ['../sql/auth.sql','../sql/app.sql'])await db.exec(await readFile(new URL(file,import.meta.url),'utf8'));
 const query=async(sql:string,values:unknown[]=[])=>{
  const result=await db.query<Record<string,unknown>>(sql,values);
  return {rows:result.rows,rowCount:result.affectedRows??result.rows.length,command:sql.trim().split(/\s/)[0]!.toUpperCase()};
 };
 let tail=Promise.resolve(),activeGates=0,peakGates=0;
 const pool={query,connect:async()=>{
  let pending=false,transaction=false,gate=false,unlock:(()=>void)|undefined;
  const releaseGate=()=>{if(unlock){activeGates--;unlock();unlock=undefined;}};
  return Object.assign(new EventEmitter(),{
   query:async(sql:string,values:unknown[]=[])=>{
    if(/^BEGIN$/i.test(sql)){pending=true;return {rows:[]};}
    if(/^SET LOCAL /i.test(sql))return {rows:[]};
    if(sql.includes('pg_advisory_xact_lock')){
     const previous=tail;let finish!:()=>void;const held=new Promise<void>(resolve=>{finish=resolve;});tail=previous.then(()=>held);
     await previous;unlock=finish;gate=true;activeGates++;peakGates=Math.max(peakGates,activeGates);return {rows:[]};
    }
    if(/^(COMMIT|ROLLBACK)$/i.test(sql)){
     if(transaction)await query(sql);pending=false;transaction=false;releaseGate();return {rows:[]};
    }
    if(pending&&!gate&&!transaction){await query('BEGIN');transaction=true;}
    return query(sql,values);
   },
   release:(_failed?:boolean)=>{releaseGate();},
  });
 },end:async()=>{}} as unknown as Pool;
 const options=authOptions(config,pool,{dialect:new PostgresDialect({pool:pool as never}),type:'postgres'});
 const auth=betterAuth({...options,plugins:options.plugins.filter(plugin=>plugin.id!=='generic-oauth')});
 const context=await auth.$context,now=new Date();
 const user=await context.adapter.create<{id:string}>({model:'user',data:{name:'Synthetic owner',email:config.ownerEmail,emailVerified:true,createdAt:now,updatedAt:now}});
 const session=await context.adapter.create<{id:string}>({model:'session',data:{userId:user.id,token:'synthetic-browser-cookie',expiresAt:new Date(Date.now()+86400000),createdAt:now,updatedAt:now}});
 const clientId='synthetic-auth-regression-client',redirectUri='https://chatgpt.com/connector/oauth/synthetic-regression';
 await context.adapter.create({model:'oauthClient',data:{clientId,disabled:false,tokenEndpointAuthMethod:'none',requirePKCE:true,grantTypes:['authorization_code','refresh_token'],responseTypes:['code'],scopes:grantedScopes,redirectUris:[redirectUri],createdAt:now,updatedAt:now}});
 if(!(await query('SELECT id FROM "oauthResource" WHERE identifier=$1',[config.resource])).rows.length)await context.adapter.create({model:'oauthResource',data:{identifier:config.resource,name:'Synthetic resource',allowedScopes:grantedScopes,disabled:false,createdAt:now,updatedAt:now}});
 await context.adapter.create({model:'oauthClientResource',data:{clientId,resourceId:config.resource,createdAt:now}});
 const consent=await context.adapter.create<{id:string}>({model:'oauthConsent',data:{userId:user.id,clientId,referenceId:user.id,scopes:grantedScopes,resources:[config.resource],createdAt:now,updatedAt:now}});
 const initialRefresh='synthetic-legacy-refresh-'+randomUUID();
 await context.adapter.create({model:'oauthRefreshToken',data:{token:hash(initialRefresh),clientId,userId:user.id,sessionId:session.id,referenceId:user.id,scopes:grantedScopes,resources:[config.resource],expiresAt:new Date(Date.now()+86400000),createdAt:now}});
 const legacy=await auth.api.signJWT({body:{payload:{sub:user.id,client_id:clientId,azp:clientId,aud:config.resource,scope:grantedScopes.join(' '),sid:session.id,iat:Math.floor(Date.now()/1000)-1,exp:Math.floor(Date.now()/1000)+300,'urn:youtube-drive-mcp:owner':user.id}}});
 // Apply after real legacy rows exist: deployment must preserve current users.
 await db.exec(await readFile(new URL('../sql/grants.sql',import.meta.url),'utf8'));
 const handler=createAuthHandler(pool,auth.handler);
 const post=async(path:string,form:Record<string,string>,handle=handler)=>{
  const request=new Request(`${config.issuer}${path}`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(form)});
  try{return await handle(request);}catch(error){if(error instanceof AppError)return Response.json({error:error.code},{status:error.status});throw error;}
 };
 const refresh=(token=initialRefresh,changes:Record<string,string>={},handle=handler)=>post('/oauth2/token',{grant_type:'refresh_token',client_id:clientId,refresh_token:token,resource:config.resource,...changes},handle);
 const rotate=async(token=initialRefresh,changes:Record<string,string>={})=>{
  const response=await refresh(token,changes);if(response.status!==200)throw new Error(`FIXTURE_ROTATION_FAILED_${response.status}_${await response.text()}`);
  return response.json() as Promise<{access_token:string;refresh_token:string}>;
 };
 const claims=async(token:string)=>{
  const response=await auth.handler(new Request(`${config.issuer}/jwks`));
  if(response.status!==200)throw new Error('FIXTURE_JWKS_FAILED');
  const jwks=await response.json();return (await jwtVerify(token,await importJWK(jwks.keys[0]),{issuer:config.issuer,audience:config.resource})).payload;
 };
 const owner=async(token:string)=>ownerFromClaims(pool,config,await claims(token));
 const authorize=async(scopes=grantedScopes)=>{
  const live=await context.adapter.create<{id:string}>({model:'session',data:{userId:user.id,token:'synthetic-new-session-'+randomUUID(),expiresAt:new Date(Date.now()+86400000),createdAt:new Date(),updatedAt:new Date()}});
  const existing=await query('SELECT id FROM "oauthConsent" WHERE "userId"=$1 AND "clientId"=$2',[user.id,clientId]);
  if(existing.rows.length)await query('UPDATE "oauthConsent" SET scopes=$3,resources=$4 WHERE "userId"=$1 AND "clientId"=$2',[user.id,clientId,JSON.stringify(scopes),JSON.stringify([config.resource])]);
  else await context.adapter.create({model:'oauthConsent',data:{userId:user.id,clientId,referenceId:user.id,scopes,resources:[config.resource],createdAt:new Date(),updatedAt:new Date()}});
  const code='synthetic-code-'+randomUUID(),verifier='synthetic-pkce-verifier-'+randomUUID();
  await context.internalAdapter.createVerificationValue({identifier:hash(code),value:JSON.stringify({type:'authorization_code',query:{response_type:'code',client_id:clientId,redirect_uri:redirectUri,scope:scopes.join(' '),code_challenge:hash(verifier),code_challenge_method:'S256'},userId:user.id,sessionId:live.id,referenceId:user.id,resource:[config.resource]}),expiresAt:new Date(Date.now()+60000),createdAt:new Date(),updatedAt:new Date()});
  const response=await post('/oauth2/token',{grant_type:'authorization_code',client_id:clientId,code,code_verifier:verifier,redirect_uri:redirectUri,resource:config.resource});
  if(response.status!==200)throw new Error(`FIXTURE_AUTHORIZATION_FAILED_${response.status}_${await response.text()}`);
  return response.json() as Promise<{access_token:string;refresh_token:string}>;
 };
 return {db,pool,auth,query,context,handler,post,refresh,rotate,owner,claims,authorize,userId:user.id,clientId,sessionId:session.id,consentId:consent.id,initialRefresh,legacyAccess:legacy.token,peakGates:()=>peakGates,close:()=>db.close()};
}
