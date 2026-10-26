import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import {OAuth2Client} from 'google-auth-library';
import {Providers,type ConnectionRow} from '../src/providers.ts';
import {Service} from '../src/service.ts';
import {PROVIDER_SCOPES} from '../src/config.ts';
import {createUi} from '../src/ui.ts';
import type {Auth} from '../src/auth.ts';
import {config} from './fixtures.ts';
const extra=['https://www.googleapis.com/auth/youtube.readonly','https://www.googleapis.com/auth/yt-analytics.readonly'];
const scopes=[...PROVIDER_SCOPES.youtube,...extra];
const dates={startDate:'2026-10-01',endDate:'2026-10-03'};
const job={id:'job-1',reportTypeId:'channel_reach_basic_a1',name:'Reach'};
const report={id:'report-1',jobId:job.id,startTime:'2026-10-01T07:00:00Z',endTime:'2026-10-02T07:00:00Z',createTime:'2026-10-03T00:00:00Z'};
const download='https://youtubereporting.googleapis.com/v1/media/CHANNEL/'+config.youtubeChannelId.slice(2)+'/jobs/job-1/reports/report-1?alt=media';
function fixture(handler:(u:URL,init:RequestInit)=>Response|Promise<Response>,granted:string[]=scopes){
 const row={owner_id:'owner',provider:'youtube',subject:'channel-sub',email:'channel@example.com',scopes:granted,channel_id:config.youtubeChannelId,auth_state:'active'} as ConnectionRow;
 const calls:string[]=[];const query=async(sql:string)=>({rows:sql.includes('advisory')?[{locked:true}]:[]});const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool;
 const p=new Providers(pool,config,async(target,init={})=>{const u=new URL(String(target));calls.push(u.pathname);assert.equal(init.redirect,'error');if(u.pathname==='/youtube/v3/channels')return Response.json({items:[{id:config.youtubeChannelId}]});return handler(u,init);});
 p.requireChannel=async()=>row;p.connection=async()=>row;p.list=async()=>[row];p.token=async()=> 'fixture-access';
 const s=new Service(p,'owner');const a=(s as any).analytics;return {row,p,s,a,calls};
}
function capability(a:any){assert.ok(a,'Service must expose the analytics capability');return a;}
test('missing analytics consent is visible in existing status and preserves upload connection',async()=>{
 const f=fixture(()=>{throw Error('no analytics request without permission');},[...PROVIDER_SCOPES.youtube]);const status=await f.s.status() as any;
 assert.equal(status.analytics?.ready,false);assert.deepEqual(status.analytics?.missingScopes,extra);await assert.rejects(capability(f.a).report({profile:'summary',...dates}),{code:'ANALYTICS_AUTH_REQUIRED'});assert.equal(f.row.auth_state,'active');assert.deepEqual(f.calls,[]);
});
test('fixed profiles reject invalid calendar dates, foreign inputs and incompatible video filters before network',async()=>{
 const f=fixture(()=>{throw Error('must validate first');});const a=capability(f.a);
 for(const input of [{profile:'summary',...dates,startDate:'2026-02-30'},{profile:'summary',...dates,startDate:'2026-10-04'},{profile:'retention',...dates},{profile:'summary',...dates,metrics:'estimatedRevenue'},{profile:'summary',...dates,channelId:'other'},{profile:'summary',...dates,url:'https://evil.example'},{profile:'summary',...dates,videoId:'bad/id'}])await assert.rejects(a.report(input));
 assert.deepEqual(f.calls,[]);
});
test('daily analytics uses pinned channel, original sparse dates and Pacific reporting timezone',async()=>{
 const f=fixture(u=>{assert.equal(u.hostname,'youtubeanalytics.googleapis.com');assert.equal(u.searchParams.get('ids'),'channel=='+config.youtubeChannelId);assert.equal(u.searchParams.get('dimensions'),'day');return Response.json({columnHeaders:[{name:'day'},{name:'views'}],rows:[['2026-10-01',5],['2026-10-02',2]]});});
 const data=await capability(f.a).report({profile:'daily',...dates});assert.deepEqual(data.availableDates,['2026-10-01','2026-10-02']);assert.equal(data.dataThrough,'2026-10-02');assert.equal(data.sourceTimezone,'America/Los_Angeles');assert.equal(data.rows.length,2);
});
test('summary does not invent availableThrough from requested end and empty has no fabricated zero',async()=>{
 const f=fixture(()=>Response.json({columnHeaders:[{name:'views'}]}));const result=await capability(f.a).report({profile:'summary',...dates});assert.equal(result.state,'empty');assert.deepEqual(result.rows,[]);assert.equal(result.dataThrough,null);assert.equal(result.dataThroughReason,'NO_DAY_DIMENSION');assert.deepEqual(result.requestedPeriod,dates);
});
test('retention preserves original 100 bins and verifies single video belongs to channel',async()=>{
 const bins=Array.from({length:100},(_,i)=>[(i+1)/100,0.8]);const f=fixture(u=>u.pathname==='/youtube/v3/videos'?Response.json({items:[{snippet:{channelId:config.youtubeChannelId}}]}):Response.json({columnHeaders:[{name:'elapsedVideoTimeRatio'},{name:'audienceWatchRatio'}],rows:bins}));
 const result=await capability(f.a).report({profile:'retention',videoId:'abcdefghijk',...dates});assert.deepEqual(result.rows,bins);assert.equal(result.retentionSampling,'PROVIDER_BINS');assert.equal(result.exactThirtySecondValueAvailable,false);
 const wrong=fixture(()=>Response.json({items:[{snippet:{channelId:'other'}}]}));await assert.rejects(capability(wrong.a).report({profile:'retention',videoId:'abcdefghijk',...dates}),{code:'YOUTUBE_VIDEO_CHANNEL_MISMATCH'});
});
test('current token channel mismatch prevents Analytics and Reporting requests',async()=>{
 const f=fixture(()=>Response.json({}));
 // Use the production request method's channel boundary with an injected HTTP response.
 const p=new Providers(f.p.pool,config,async()=>Response.json({items:[{id:'other'}]}));p.requireChannel=async()=>f.row;p.token=async()=> 'fixture-access';
 await assert.rejects(capability((new Service(p,'owner') as any).analytics).types({}),{code:'YOUTUBE_CHANNEL_MISMATCH'});
});
test('analytics permission denial preserves provider auth_state and distinguishes quota',async()=>{
 for(const reason of ['insufficientPermissions','quotaExceeded']){const f=fixture(()=>Response.json({error:{errors:[{reason}]}},{status:403}));await assert.rejects(capability(f.a).report({profile:'summary',...dates}),{code:reason==='quotaExceeded'?'GOOGLE_QUOTA_OR_RATE_LIMIT':'ANALYTICS_AUTH_REQUIRED'});assert.equal(f.row.auth_state,'active');}
});
test('report-type discovery accepts current supported families without hardcoding old versions',async()=>{
 const f=fixture(()=>Response.json({reportTypes:[{id:'channel_cards_a1',name:'Cards'},{id:'channel_reach_basic_a1',name:'Reach basic'},{id:'channel_reach_combined_a1',name:'Reach combined'},{id:'channel_end_screens_a2',name:'End'},{id:'content_owner_reach_a1'},{id:'channel_reach_a1'},{id:'channel_cards_a0',deprecateTime:'2020-01-01T00:00:00Z'}]}));
 const result=await capability(f.a).types({});assert.deepEqual(result.reportTypes.map((x:any)=>x.id),['channel_cards_a1','channel_reach_basic_a1','channel_reach_combined_a1','channel_end_screens_a2']);
});
test('enable lists provider jobs first, reuses existing job and creates exactly once on retry',async()=>{
 let created=false,posts=0;const f=fixture((u,init)=>{if(u.pathname.endsWith('/reportTypes'))return Response.json({reportTypes:[{id:job.reportTypeId}]});if(init.method==='POST'){posts++;created=true;assert.equal(JSON.parse(String(init.body)).reportTypeId,job.reportTypeId);return Response.json(job);}return Response.json({jobs:created?[job]:[],...(created?{}:{})});});const a=capability(f.a);
 const first=await a.enable({reportTypeId:job.reportTypeId});assert.equal(first.alreadyPresent,false);const retry=await a.enable({reportTypeId:job.reportTypeId});assert.equal(retry.alreadyPresent,true);assert.equal(posts,1);
});
test('report listing rejects mismatched job and strips download URLs; no reports is pending',async()=>{
 const f=fixture(u=>u.pathname.endsWith('/reports')?Response.json({reports:[{...report,downloadUrl:download}]}):Response.json(job));const result=await capability(f.a).reports({jobId:job.id});assert.equal(result.state,'available');assert.doesNotMatch(JSON.stringify(result),/downloadUrl|alt=media/);
 const empty=fixture(u=>Response.json(u.pathname.endsWith('/reports')?{}:job));assert.equal((await capability(empty.a).reports({jobId:job.id})).state,'pending');
 const wrong=fixture(()=>Response.json({...job,id:'other'}));await assert.rejects(capability(wrong.a).reports({jobId:job.id}),{code:'REPORTING_JOB_MISMATCH'});
});
test('CSV parser handles BOM, quoted commas/newlines/quotes and explicitly truncates rows without totals',async()=>{
 const f=fixture(u=>u.pathname.startsWith('/v1/media/')?new Response('\uFEFFdate,video_id,note\r\n20261001,abcdefghijk,"a,b\n""quoted"""\r\n20261001,abcdefghijk,last\r\n'):Response.json(u.pathname.endsWith('/reports/report-1')?{...report,downloadUrl:download}:job));
 const result=await capability(f.a).csv({jobId:job.id,reportId:report.id,rowLimit:1});assert.deepEqual(result.headers,['date','video_id','note']);assert.equal(result.rows[0][2],'a,b\n"quoted"');assert.equal(result.truncated,true);assert.equal(result.complete,false);assert.equal(result.returnedRows,1);assert.equal(result.totalRows,2);assert.equal(result.aggregate,null);assert.doesNotMatch(JSON.stringify(result),/downloadUrl|alt=media/);
});
test('CSV rejects foreign origin/path/job/report and caller URL before a media request',async()=>{
 for(const url of ['https://evil.example/report','http://youtubereporting.googleapis.com/v1/media/x',download.replace('job-1','other'),download.replace('/CHANNEL/','/CONTENT_OWNER/'),download+'&token=unsafe',download.replace('report-1','other')]){
  const f=fixture(u=>Response.json(u.pathname.endsWith('/reports/report-1')?{...report,downloadUrl:url}:job));await assert.rejects(capability(f.a).csv({jobId:job.id,reportId:report.id}));assert.ok(!f.calls.some(x=>x.startsWith('/v1/media/')));
 }
 const f=fixture(()=>{throw Error('must reject before request');});await assert.rejects(capability(f.a).csv({jobId:job.id,reportId:report.id,url:download}));
});
test('CSV rejects oversized content, malformed quotes, unequal columns and invalid UTF-8',async()=>{
 for(const content of ['a,b\n"unterminated','a,b\n1,2,3','a\n'+'x'.repeat(1024*1024),new Uint8Array([0xff])]){
  const f=fixture(u=>u.pathname.startsWith('/v1/media/')?new Response(content):Response.json(u.pathname.endsWith('/reports/report-1')?{...report,downloadUrl:download}:job));await assert.rejects(capability(f.a).csv({jobId:job.id,reportId:report.id}));
 }
});
const auth={api:{getSession:async()=>({user:{id:'owner',email:config.ownerEmail,emailVerified:true},session:{id:'session'}})}} as unknown as Auth;
test('owner web/mobile controls call same methods and retain origin/session boundaries',async()=>{
 const f=fixture(()=>Response.json({columnHeaders:[],rows:[]}));const ui=createUi(auth,config,f.p);const page=await ui(new Request(config.origin+'/connect'));const html=await page.text();assert.match(html,/\/ui\/analytics-consent/);assert.match(html,/\/ui\/analytics-report/);assert.match(html,/textContent/);assert.match(html,/\/ui\/reporting-csv/);
 const post=(headers:Record<string,string>,body:unknown)=>new Request(config.origin+'/ui/analytics-report',{method:'POST',headers,body:JSON.stringify(body)});
 const headers={Origin:config.origin,'Content-Type':'application/json'};const result=await ui(post(headers,{profile:'summary',...dates}));assert.equal(result.status,200);assert.equal((await result.json()).source,'YouTube Analytics API');
 await assert.rejects(ui(post({...headers,Origin:'https://evil.example'},{profile:'summary',...dates})),{code:'INVALID_ORIGIN'});
 const anonymous=createUi({api:{getSession:async()=>null}} as unknown as Auth,config,f.p);await assert.rejects(anonymous(post(headers,{profile:'summary',...dates})),{code:'AUTH_REQUIRED'});
});
test('incremental consent adds only two scopes and keeps regular reconnection compatible',async()=>{
 const query=async()=>({rows:[]});const pool={query} as unknown as Pool;const p=new Providers(pool,config);p.requireChannel=async()=>({subject:'channel-sub',channel_id:config.youtubeChannelId} as ConnectionRow);
 const regular=new URL(await p.begin('owner','session','youtube'));assert.equal(regular.searchParams.get('scope'),PROVIDER_SCOPES.youtube.join(' '));
 const expanded=new URL(await (p.begin as any)('owner','session','youtube',true));for(const scope of extra)assert.ok(expanded.searchParams.get('scope')!.split(' ').includes(scope));
});
test('analytics OAuth reconsent rejects changed subject and partial scopes without replacing credentials',async()=>{
 for(const mode of ['subject','partial','nonce','success'] as const){
  let saved=false;let state:any;const old={subject:'channel-sub',scopes,refresh_cipher:'unused',refresh_expires_at:null};const query=async(sql:string,values?:unknown[])=>{if(sql.includes('INSERT INTO provider_states'))state={provider:'youtube',verifier_cipher:values![4],nonce:values![5]};if(sql.includes('DELETE FROM provider_states')&&sql.includes('RETURNING'))return {rows:[state]};if(sql.includes('SELECT * FROM provider_connections'))return {rows:[old]};if(sql.includes('INSERT INTO provider_connections'))saved=true;return {rows:[]};};
  const pool={query,connect:async()=>({query,release(){}})} as unknown as Pool;const p=new Providers(pool,config,async()=>Response.json({items:[{id:config.youtubeChannelId}]}));old.refresh_cipher=p.cipher.seal('fixture-old-refresh',p.context('owner','youtube'));p.requireChannel=async()=>({subject:old.subject,channel_id:config.youtubeChannelId} as ConnectionRow);
  const u=new URL(await (p.begin as any)('owner','session','youtube',true));const get=OAuth2Client.prototype.getToken,verify=OAuth2Client.prototype.verifyIdToken;
  (OAuth2Client.prototype as any).getToken=async()=>({tokens:{id_token:'fixture-id',access_token:'fixture-access',refresh_token:'fixture-refresh',expiry_date:Date.now()+3600000,scope:(mode==='partial'?PROVIDER_SCOPES.youtube:scopes).join(' ')}});
  (OAuth2Client.prototype as any).verifyIdToken=async()=>({getPayload:()=>({sub:mode==='subject'?'other-sub':old.subject,email:'channel@example.com',email_verified:true,nonce:mode==='nonce'?'wrong':state.nonce})});
  try{if(mode==='success'){assert.equal(await p.complete('owner','session',u.searchParams.get('state')!,'code'),'youtube');assert.equal(saved,true);}else{await assert.rejects(p.complete('owner','session',u.searchParams.get('state')!,'code'));assert.equal(saved,false);}}
  finally{OAuth2Client.prototype.getToken=get;OAuth2Client.prototype.verifyIdToken=verify;}
 }
});

test('contended reporting enable fails before provider mutation rather than retaining a database waiter',async()=>{
 const f=fixture(()=>{throw Error('no API call after lock contention except channel check');});
 (f.p.pool as any).connect=async()=>({query:async(sql:string)=>({rows:sql.includes('advisory')?[{locked:false}]:[]}),release(){}});
 await assert.rejects(capability(f.a).enable({reportTypeId:job.reportTypeId}),{code:'REPORTING_BUSY_RETRY_SAME_TYPE'});
});
test('report lookup rejects mismatched report identity and redirect responses without returning location',async()=>{
 const mismatched=fixture(u=>Response.json(u.pathname.endsWith('/reports/report-1')?{...report,jobId:'other',downloadUrl:download}:job));
 await assert.rejects(capability(mismatched.a).csv({jobId:job.id,reportId:report.id}),{code:'REPORTING_REPORT_MISMATCH'});
 const redirect=fixture(u=>u.pathname.startsWith('/v1/media/')?new Response(null,{status:302,headers:{Location:'https://evil.example/private'}}):Response.json(u.pathname.endsWith('/reports/report-1')?{...report,downloadUrl:download}:job));
 await assert.rejects(capability(redirect.a).csv({jobId:job.id,reportId:report.id}));assert.equal(redirect.calls.filter(x=>x.startsWith('/v1/media/')).length,1);
});

test('MCP tools retain read/write scope separation and fixed schemas',async()=>{
 const {handleMcp}=await import('../src/mcp.ts');const f=fixture(()=>Response.json({rows:[],columnHeaders:[]}));
 const call=async(method:string,params:unknown,scopes:string[])=>{const response=await handleMcp(new Request(config.resource,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}),f.s,new Set(scopes));const text=await response.text();return JSON.parse(text.startsWith('event:')?text.split('\n').filter(line=>line.startsWith('data: ')).at(-1)!.slice(6):text) as any;};
 const list=await call('tools/list',{},['youtube:read']);assert.ok(list.result.tools.some((t:any)=>t.name==='youtube_analytics_report'));const enable=list.result.tools.find((t:any)=>t.name==='youtube_reporting_enable');assert.equal(enable.annotations.readOnlyHint,false);assert.equal(enable.annotations.idempotentHint,true);
 const read=await call('tools/call',{name:'youtube_analytics_report',arguments:{profile:'summary',...dates}},['youtube:read']);assert.equal(JSON.parse(read.result.content[0].text).source,'YouTube Analytics API');
 const denied=await call('tools/call',{name:'youtube_reporting_enable',arguments:{reportTypeId:job.reportTypeId}},['youtube:read']);assert.ok(denied.error||denied.result?.isError);assert.ok(!f.calls.some(x=>x==='/v1/jobs'));
 const invalid=await call('tools/call',{name:'youtube_analytics_report',arguments:{profile:'summary',...dates,metrics:'estimatedRevenue'}},['youtube:read']);assert.ok(invalid.error||invalid.result?.isError);
});

test('provider job expiry distinguishes future, past and omitted values against a captured current time',async()=>{
 const referenceNow=Date.now();
 for(const [expiry,expectedState,enabled] of [[undefined,'enabled',true],[new Date(referenceNow+86400000).toISOString(),'enabled',true],[new Date(referenceNow-86400000).toISOString(),'expired',false]] as const){
  let posts=0;const existing={...job,...(expiry?{expireTime:expiry}:{})};
  const f=fixture((u,init)=>{if(init.method==='POST'){posts++;return Response.json(job);}if(u.pathname.endsWith('/reportTypes'))return Response.json({reportTypes:[{id:job.reportTypeId}]});return Response.json({jobs:[existing]});});
  const result=await capability(f.a).enable({reportTypeId:job.reportTypeId});assert.equal(result.alreadyPresent,true);assert.equal(result.state,expectedState);assert.equal(result.enabled,enabled);assert.equal(posts,0);if(!enabled)assert.match(result.actionRequired,/supported replacement/);else assert.equal(result.actionRequired,null);assert.equal(result.job.expireTime,expiry);
 }
});

test('official reach basic and combined families permit discovery, enable and owned report reads',async()=>{
 for(const reportTypeId of ['channel_reach_basic_a1','channel_reach_combined_a1']){
  const owned={...job,reportTypeId};let posts=0;
  const f=fixture((u,init)=>{if(u.pathname.endsWith('/reportTypes'))return Response.json({reportTypes:[{id:reportTypeId}]});if(init.method==='POST'){posts++;return Response.json(owned);}if(u.pathname.endsWith('/jobs'))return Response.json({jobs:[]});if(u.pathname.endsWith('/reports'))return Response.json({reports:[]});return Response.json(owned);});
  const a=capability(f.a);assert.deepEqual((await a.types({})).reportTypes.map((t:any)=>t.id),[reportTypeId]);assert.equal((await a.enable({reportTypeId})).job.reportTypeId,reportTypeId);assert.equal(posts,1);assert.equal((await a.reports({jobId:job.id})).state,'pending');
 }
});
test('provider-listed newer reach versions are accepted but invented reach families stay rejected',async()=>{
 const f=fixture((u,init)=>u.pathname.endsWith('/reportTypes')?Response.json({reportTypes:[{id:'channel_reach_basic_a99'}]}):init.method==='POST'?Response.json({...job,reportTypeId:'channel_reach_basic_a99'}):Response.json({jobs:[]}));
 const a=capability(f.a);assert.equal((await a.enable({reportTypeId:'channel_reach_basic_a99'})).job.reportTypeId,'channel_reach_basic_a99');
 for(const reportTypeId of ['channel_reach_a1','channel_reach_wrong_a1','content_owner_reach_basic_a1'])await assert.rejects(a.enable({reportTypeId}));
});
