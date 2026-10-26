import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {createRuntime} from '../src/runtime.ts';
import {config} from './fixtures.ts';

async function runtimeFixture(){
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async target=>{
  if(String(target)==='https://accounts.google.com/.well-known/openid-configuration')return Response.json({issuer:'https://accounts.google.com',authorization_endpoint:'https://accounts.google.com/o/oauth2/v2/auth',token_endpoint:'https://oauth2.googleapis.com/token',jwks_uri:'https://www.googleapis.com/oauth2/v3/certs'});
  throw new Error('public pages must not call external services');
 };
 const pool=new Pool({connectionString:config.databaseUrl,max:1});
 const runtime=createRuntime(config,pool);
 return {runtime,close:async()=>{await pool.end();globalThis.fetch=originalFetch;}};
}

test('public homepage explains the app and links privacy and terms without login',async()=>{
 const {runtime,close}=await runtimeFixture();
 try{const response=await runtime.fetch(new Request(config.origin+'/'));const html=await response.text();assert.equal(response.status,200);assert.match(html,/Google Drive/);assert.match(html,/YouTube/);assert.match(html,/href="\/privacy"/);assert.match(html,/href="\/terms"/);assert.doesNotMatch(html,/refresh-fixture|channel@example\.com|access_cipher/);}
 finally{await close();}
});

test('privacy and terms are public product information pages with accurate data and recovery details',async()=>{
 const {runtime,close}=await runtimeFixture();
 try{for(const path of ['/privacy','/terms']){const response=await runtime.fetch(new Request(config.origin+path));const html=await response.text();assert.equal(response.status,200);assert.match(response.headers.get('content-type')??'',/text\/html/);assert.match(html,/Google/);assert.match(html,/Vercel/);assert.match(html,/Neon/);assert.match(html,/href="\/"/);assert.ok(response.headers.get('content-security-policy'));assert.doesNotMatch(html,/access_cipher|refresh_cipher|fixture-only/);if(path==='/privacy'){assert.match(html,/Limited Use/);assert.match(html,/shaterguy@gmail\.com/);assert.match(html,/학습/);assert.match(html,/지속.*파일/);}}
 }finally{await close();}
});
