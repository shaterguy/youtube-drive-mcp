import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {betterAuth} from 'better-auth';
import {memoryAdapter} from 'better-auth/adapters/memory';
import type {Pool} from 'pg';
import {authOptions} from '../src/auth.ts';
import {config} from './fixtures.ts';
test('real MCP OAuth refresh survives expired or deleted web sessions and service reauthorization state',async()=>{
 const now=new Date();const user={id:'owner',name:'Owner',email:config.ownerEmail,emailVerified:true,createdAt:now,updatedAt:now};
 const data:Record<string,any[]>={user:[user],session:[{id:'expired-web-session',token:'expired-cookie',userId:'owner',expiresAt:new Date(Date.now()-86400000),createdAt:now,updatedAt:now}],account:[],verification:[],jwks:[],oauthClient:[{id:'client-row',clientId:'fixture-client',clientSecret:null,disabled:false,redirectUris:['https://chatgpt.com/connector/oauth/fixture'],grantTypes:['authorization_code','refresh_token'],responseTypes:['code'],tokenEndpointAuthMethod:'none',requirePKCE:true,scopes:['offline_access','drive:read'],createdAt:now,updatedAt:now}],oauthRefreshToken:[],oauthAccessToken:[],oauthConsent:[{id:'consent',clientId:'fixture-client',userId:'owner',referenceId:'owner',resources:[config.resource],scopes:['offline_access','drive:read'],createdAt:now,updatedAt:now}],oauthResource:[{id:'resource-row',identifier:config.resource,name:'YouTube Drive MCP',allowedScopes:['offline_access','drive:read'],disabled:false,createdAt:now,updatedAt:now}],oauthClientResource:[{id:'resource-link',clientId:'fixture-client',resourceId:config.resource,createdAt:now}],oauthClientAssertion:[]};
 const raw='fixture-initial-refresh-token';data.oauthRefreshToken!.push({id:'refresh-row',token:createHash('sha256').update(raw).digest('base64url'),clientId:'fixture-client',sessionId:'expired-web-session',userId:'owner',referenceId:'owner',resources:[config.resource],scopes:['offline_access','drive:read'],createdAt:now,expiresAt:new Date(Date.now()+3600000),revoked:null,rotatedAt:null});
 const pool={query:async()=>({rows:[{email:config.ownerEmail,emailVerified:true}]})} as unknown as Pool;
 const originalFetch=globalThis.fetch;globalThis.fetch=async target=>{if(String(target)==='https://accounts.google.com/.well-known/openid-configuration')return Response.json({issuer:'https://accounts.google.com',authorization_endpoint:'https://accounts.google.com/o/oauth2/v2/auth',token_endpoint:'https://oauth2.googleapis.com/token',jwks_uri:'https://www.googleapis.com/oauth2/v3/certs'});throw new Error('unexpected test network');};
 try{const auth=betterAuth(authOptions(config,pool,memoryAdapter(data)));await auth.$context;
  const refresh=async(token:string)=>{const response=await auth.handler(new Request(`${config.issuer}/oauth2/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:'fixture-client',refresh_token:token,resource:config.resource})}));return {response,body:await response.json() as Record<string,any>};};
  const first=await refresh(raw);assert.equal(first.response.status,200,JSON.stringify(first.body));assert.ok(first.body.access_token);assert.ok(first.body.refresh_token);assert.notEqual(first.body.refresh_token,raw);
  // Deleting the browser session through the actual internal adapter fires the MCP logout hook.
  await (await auth.$context).internalAdapter.deleteSession('expired-cookie');assert.equal(data.session!.length,0);
  const second=await refresh(first.body.refresh_token);assert.equal(second.response.status,200,JSON.stringify(second.body));assert.ok(second.body.access_token);assert.ok(second.body.refresh_token);
 }finally{globalThis.fetch=originalFetch;}
});
