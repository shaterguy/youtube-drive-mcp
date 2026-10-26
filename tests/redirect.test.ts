import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Auth} from '../src/auth.ts';
import {noStore} from '../src/config.ts';
import type {Providers} from '../src/providers.ts';
import {createUi} from '../src/ui.ts';
import {config} from './fixtures.ts';

test('completed Google provider callback returns its 303 redirect with safety headers',async()=>{
 let completed=0;
 const auth={api:{getSession:async()=>({user:{id:'owner',email:config.ownerEmail,emailVerified:true},session:{id:'owner-session'}})}} as unknown as Auth;
 const providers={complete:async(owner:string,session:string,state:string,code:string)=>{assert.equal(owner,'owner');assert.equal(session,'owner-session');assert.equal(state,'fixture-state');assert.equal(code,'fixture-code');completed++;return 'drive';}} as unknown as Providers;
 const response=await createUi(auth,config,providers)(new Request(config.origin+'/google/callback?state=fixture-state&code=fixture-code'));
 assert.equal(completed,1);assert.equal(response.status,303);assert.equal(response.headers.get('location'),config.origin+'/connect');assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('referrer-policy'),'no-referrer');assert.equal(response.headers.get('x-content-type-options'),'nosniff');
});

test('noStore preserves response status, body, location and separate Set-Cookie headers',async()=>{
 const headers=new Headers({Location:config.origin+'/connect'});headers.append('Set-Cookie','fixture-a=one; HttpOnly; Secure');headers.append('Set-Cookie','fixture-b=two; HttpOnly; Secure');
 const original=new Response('fixture-body',{status:202,statusText:'Accepted',headers});
 const response=noStore(original);assert.equal(response.status,202);assert.equal(response.statusText,'Accepted');assert.equal(await response.text(),'fixture-body');assert.equal(response.headers.get('location'),config.origin+'/connect');assert.deepEqual(response.headers.getSetCookie(),['fixture-a=one; HttpOnly; Secure','fixture-b=two; HttpOnly; Secure']);
});
