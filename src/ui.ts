import {randomBytes} from 'node:crypto';
import {verifyOAuthQueryParams} from '@better-auth/oauth-provider';
import {ownerSession,type Auth} from './auth.ts';
import {AppError,MCP_SCOPES,noStore,provider,type Config} from './config.ts';
import {bounded} from './http.ts';
import {Providers} from './providers.ts';
import {Service} from './service.ts';
import {uploadShape} from './mcp.ts';
import {analyticsInput,reportingPageInput,reportingJobInput,reportingEnableInput,reportingCsvInput} from './analytics.ts';
import * as z from 'zod/v4';
const escape=(v:unknown)=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function page(title:string,body:string,oauthQuery=''){
 const nonce=randomBytes(18).toString('base64');
 const script=`const oq=${JSON.stringify(oauthQuery).replace(/</g,'\\u003c')};const out=document.getElementById('status');
 async function post(path,body){const response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,oauth_query:oq})});const data=await response.json();if(!response.ok)throw Error(data.error||'REQUEST_FAILED');return data;}
 async function transfer(job){out.textContent=JSON.stringify(job,null,2);while(job.status==='created'||job.status==='uploading'){await new Promise(r=>setTimeout(r,100));job=await post('/ui/upload-step',{jobId:job.jobId});out.textContent=JSON.stringify(job,null,2);}return job;}
 document.querySelectorAll('form').forEach(form=>form.addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;out.textContent='처리 중입니다.';try{const body=Object.fromEntries(new FormData(form));if(button.name)body[button.name]=button.value;if('accept'in body)body.accept=body.accept==='true';const data=await post(form.action,body);if(form.action.endsWith('/ui/upload')||form.action.endsWith('/ui/upload-step'))await transfer(data);else if(data.url){const u=new URL(data.url,location.origin);if(u.protocol!=='https:')throw Error('INVALID_REDIRECT');location.assign(u.href);}else out.textContent=JSON.stringify(data,null,2);}catch(error){out.textContent=error.message+' — 같은 작업 ID로 다시 진행할 수 있습니다.';}finally{button.disabled=false;}}));`;
 return noStore(new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style nonce="${nonce}">body{font:16px system-ui,sans-serif;background:#f5f6f8;color:#17202a;margin:0}main{max-width:860px;margin:40px auto;padding:28px;background:white;border-radius:12px}h1{font-size:28px}section{border-top:1px solid #ddd;padding:20px 0}label{display:block;margin:12px 0}input,textarea,select,button{font:inherit;padding:10px;max-width:100%;box-sizing:border-box}input,textarea{width:100%}button{cursor:pointer;background:#143f65;color:white;border:0;border-radius:6px}pre{white-space:pre-wrap;overflow-wrap:anywhere}form{margin:12px 0}small{color:#52606d}</style></head><body><main><h1>${escape(title)}</h1>${body}<pre id="status" role="status"></pre></main><script nonce="${nonce}">${script}</script></body></html>`,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`}}));
}
export function createUi(auth:Auth,config:Config,providers:Providers){
 async function signed(query:unknown,optional=false){if(optional&&(query===undefined||query===''))return '';if(typeof query!=='string'||query.length>16384||!await verifyOAuthQueryParams(query,(await auth.$context).secret))throw new AppError('INVALID_AUTHORIZATION_REQUEST');return query;}
 async function forward(request:Request,path:string,body:Record<string,unknown>){const headers=new Headers(request.headers);headers.set('Content-Type','application/json');headers.delete('content-length');return noStore(await auth.handler(new Request(`${config.issuer}${path}`,{method:'POST',headers,body:JSON.stringify(body)})));}
 return async(request:Request):Promise<Response>=>{
  const u=new URL(request.url);const path=u.pathname;
  if(request.method==='GET'){
   if(path==='/privacy')return page('개인정보 처리 안내 · Privacy Policy',`<p>YouTube Drive MCP는 개인 운영자가 자신의 Google Drive 자료를 별도로 승인한 YouTube 채널로 전송하고 관리하는 개인용 서비스입니다.</p>
    <section><h2>처리하는 정보와 목적</h2><p>Google 로그인 식별자와 이메일, 로그인 세션 및 MCP 연결 승인정보를 처리합니다. Google API 권한의 연속성을 유지하기 위해 서비스별 인증 토큰을 암호화하여 저장합니다. 선택한 원본 파일의 메타데이터와 업로드 작업 상태도 중단 후 재개와 중복 전송 방지를 위해 Neon Postgres에 저장합니다.</p>
    <p>승인한 채널의 조회수·시청 시간·유지율과 도달·최종 화면·카드 분석을 Google Analytics/Reporting API에서 요청 시 읽습니다. 분석 응답과 최대 1 MiB의 보고서 CSV는 서버 메모리에서 처리하여 인증된 요청자에게 반환하며 별도로 저장하지 않습니다. Google이 생성하는 보고서 작업은 Google에서 유지됩니다. 분석 권한 추가는 선택 사항이며 기존 전송 권한과 별도로 확인합니다.</p>
    <p>사용자가 요청한 Drive 영상 바이트는 Vercel 서버의 청크 메모리를 경유하여 YouTube로 전송됩니다. 서버의 지속적인 파일 저장소에는 영상을 저장하지 않습니다. Google, Vercel, Neon의 인프라를 사용하며, 요청한 기능을 수행하는 범위에서 각 인프라가 정보를 처리합니다.</p></section>
    <section><h2>정보의 사용과 보관</h2><p>개인정보를 광고, 판매 또는 모델 학습 목적으로 사용하지 않습니다. Google API에서 받은 정보의 사용은 <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>의 Limited Use 요건을 준수합니다. 저장한 정보는 로그인, 승인한 API 기능의 연속성 및 업로드 작업 복구를 위해 보관합니다.</p></section>
    <section><h2>권한 철회와 삭제 문의</h2><p>Google 서비스 권한은 <a href="https://myaccount.google.com/connections">Google 계정의 제3자 연결 관리</a>에서 철회할 수 있습니다. 웹페이지 로그아웃은 해당 웹 로그인 세션을 종료하며 Google 서비스 권한이나 독립된 MCP 연결 승인을 자동으로 철회하지 않습니다. Google 권한이 철회되거나 만료되면 해당 서비스의 연결을 다시 승인하여 복구합니다.</p>
    <p>저장된 연결정보나 작업 데이터의 삭제가 필요하면 개인 운영자에게 <a href="mailto:${escape(config.ownerEmail)}">${escape(config.ownerEmail)}</a>로 요청할 수 있습니다. 이 페이지는 자동 데이터 삭제 기능을 제공하지 않습니다.</p></section><p><a href="/">서비스 홈</a> · <a href="/terms">이용 안내</a></p>`);
   if(path==='/terms')return page('이용 안내 · Terms of Use',`<p>YouTube Drive MCP는 승인된 개인 계정 소유자가 자신의 Google Drive와 YouTube 채널을 연결하여 사용하는 개인용 도구입니다. 메인계정의 Drive 접근 권한과 채널계정의 YouTube 권한은 각각 승인하여 연결합니다.</p>
    <section><h2>파일 전송과 영상 관리</h2><p>사용자가 승인한 파일 전송과 영상 관리 요청을 수행하며, 영상은 요청에서 명시한 공개 상태에 따라 업로드합니다. 예약 공개, 제목·설명·썸네일·재생목록 변경도 사용자가 요청한 범위에서 처리합니다. 중단된 전송은 저장된 동일 작업을 이어서 처리합니다.</p></section>
    <section><h2>연결과 운영 조건</h2><p>Google API의 권한·할당량·영상 처리 상태와 Vercel의 실행시간, Neon의 데이터베이스 가용성 등 외부 서비스의 운영 조건이 적용됩니다. 액세스 토큰의 일반적인 만료는 자동 갱신으로 처리합니다. 외부 서비스에서 권한을 철회하거나 승인이 만료된 경우에는 해당 서비스의 연결을 다시 승인하여 복구해야 합니다.</p></section>
    <p>데이터 처리와 삭제 문의 방법은 <a href="/privacy">개인정보 처리 안내</a>에서 확인할 수 있습니다.</p><p><a href="/">서비스 홈</a> · <a href="/privacy">개인정보 처리 안내</a></p>`);
   if(path==='/'||path==='/sign-in'){
    const errorOnly=[...u.searchParams.keys()].every(k=>['error','error_description'].includes(k));const query=await signed(errorOnly?'':u.search.slice(1),true);
    return page('YouTube Drive MCP',`<p>개인 운영자의 Google Drive 파일을 별도로 승인한 YouTube 채널로 전송하고 관리하는 도구입니다. 비공개 Drive 자료도 원본 계정의 권한으로 읽고, 영상은 연결한 채널계정의 권한으로 업로드합니다.</p><p>MCP 로그인은 운영자의 메인계정을 사용합니다. Drive와 YouTube의 서비스 연결은 로그인 후 각각 설정합니다.</p><form action="/ui/sign-in"><button>메인계정으로 Google 로그인</button></form><p><a href="/privacy">개인정보 처리 안내 · Privacy Policy</a> · <a href="/terms">이용 안내 · Terms of Use</a></p><p><small>ChatGPT MCP 주소: ${escape(config.resource)}</small></p>`,query);
   }
   const current=await ownerSession(auth,config,request);
   if(path==='/google/callback'){
    if(u.searchParams.has('error'))throw new AppError('GOOGLE_AUTHORIZATION_CANCELLED',409);const state=u.searchParams.get('state'),code=u.searchParams.get('code');if(!state||state.length>512||!code||code.length>4096)throw new AppError('INVALID_OAUTH_CALLBACK');await providers.complete(current.user.id,current.session.id,state,code);return noStore(Response.redirect(`${config.origin}/connect`,303));
   }
   if(path==='/consent'){
    const query=await signed(u.search.slice(1));const params=new URLSearchParams(query);const clientId=params.get('client_id');const scopes=(params.get('scope')??'').split(' ').filter(Boolean);if(!clientId||!scopes.every(s=>(MCP_SCOPES as readonly string[]).includes(s)))throw new AppError('INVALID_AUTHORIZATION_REQUEST');const client=await auth.api.getOAuthClientPublic({headers:request.headers,query:{client_id:clientId}});
    return page('ChatGPT 연결 승인',`<p>로그인: ${escape(current.user.email)}</p><p>클라이언트: ${escape(client.client_name??clientId)}</p><ul>${scopes.map(s=>`<li>${escape(s)}</li>`).join('')}</ul><p>Google 서비스 권한은 독립적으로 갱신되며, 일반적인 액세스 토큰 만료로 이 MCP 연결을 다시 설정할 필요가 없습니다.</p><form action="/ui/consent"><button name="accept" value="true">연결 허용</button> <button name="accept" value="false">취소</button></form>`,query);
   }
   if(path==='/connect'){
    const state=await providers.list(current.user.id);const cards=['drive','youtube'].map(p=>{const row=state.find(x=>x.provider===p);return `<section><h2>${p==='drive'?'메인계정 Drive':'채널계정 YouTube'}</h2><p>${row?`${escape(row.email)} · ${escape(row.auth_state)}${row.channel_title?' · '+escape(row.channel_title):''}${row.refresh_expires_at?' · Google 승인 만료 '+escape(row.refresh_expires_at):''}`:'아직 연결되지 않았습니다.'}</p><form action="/ui/provider"><input type="hidden" name="provider" value="${p}"><button>${p==='drive'?'메인계정 Drive 연결':'유튜브계정으로 채널 연결'}</button></form></section>`;}).join('');
    const analytics=await new Service(providers,current.user.id).analytics.status();
    const controls=`<section><h2>채널 분석과 보고서</h2><p>분석 권한: ${analytics.ready?'준비됨':escape(analytics.state)}. 날짜는 미국 태평양 기준이며 한국 날짜와 다릅니다.</p><form action="/ui/analytics-consent"><button>현재 채널계정의 분석 읽기 권한 추가 승인</button></form><form action="/ui/analytics-status"><button>분석 연결 상태 확인</button></form><form action="/ui/analytics-report"><label>보고서<select name="profile"><option value="summary">요약</option><option value="daily">일별</option><option value="videos">상위 영상</option><option value="traffic">유입 경로</option><option value="retention">영상 유지율</option></select></label><label>시작일<input type="date" name="startDate" required></label><label>종료일<input type="date" name="endDate" required></label><label>영상 ID (유지율 필수)<input name="videoId" maxlength="11"></label><button>분석 조회</button></form><form action="/ui/reporting-types"><button>현재 지원 보고서 유형 조회</button></form><form action="/ui/reporting-jobs"><button>보고서 작업 조회</button></form><form action="/ui/reporting-enable"><label>지원 유형 ID<input name="reportTypeId" required></label><button>이 유형의 일별 보고서 생성 활성화</button></form><form action="/ui/reporting-reports"><label>작업 ID<input name="jobId" required></label><button>생성된 보고서 조회</button></form><form action="/ui/reporting-csv"><label>작업 ID<input name="jobId" required></label><label>보고서 ID<input name="reportId" required></label><button>CSV 앞 100행 읽기</button></form><p>CSV는 최대 1 MiB만 읽습니다. 일부 행은 전체 합계가 아니며 첫 보고서는 아직 생성 대기일 수 있습니다. 유지율은 원래 구간을 반환하며 정확한 30초 값으로 바꾸지 않습니다.</p></section>`;
    return page('계정 연결과 영상 전송',`<p>로그인: ${escape(current.user.email)}</p>${cards}${controls}<section><h2>Drive 영상 업로드</h2><p>메인계정 Drive에서 읽어 채널계정의 지정 채널로 전송합니다. 이 페이지가 열려 있으면 청크를 자동으로 이어서 전송합니다.</p><form action="/ui/upload"><label>Drive 파일 ID<input name="driveFileId" required></label><label>중복 방지 키<input name="idempotencyKey" placeholder="한 영상 업로드에 계속 같은 값을 사용합니다." required></label><label>영상 제목<input name="title" maxlength="100" required></label><label>설명<textarea name="description" rows="4"></textarea></label><label>공개 상태<select name="privacyStatus"><option value="private">비공개</option><option value="unlisted">일부 공개</option><option value="public">공개</option></select></label><button>영상 전송 시작</button></form><form action="/ui/upload-step"><label>중단된 작업 ID<input name="jobId" required></label><button>같은 작업 이어서 전송</button></form></section><section><p>Google에서 권한을 철회하거나 기간 제한 승인이 만료되면 해당 서비스 연결만 다시 승인하면 됩니다. MCP 연결과 저장된 전송 작업은 유지됩니다.</p><form action="/ui/sign-out"><button>이 웹페이지에서 로그아웃</button></form></section>`);
   }
  }
  if(request.method!=='POST'||request.headers.get('origin')!==config.origin||!request.headers.get('content-type')?.startsWith('application/json'))throw new AppError('INVALID_ORIGIN');
  const input=await (await bounded(request,32768)).json() as Record<string,unknown>;if(!input||typeof input!=='object'||Array.isArray(input))throw new AppError('INVALID_REQUEST');
  const query=await signed(input.oauth_query,true);
  if(path==='/ui/sign-in')return forward(request,'/sign-in/social',{provider:'google',callbackURL:`${config.origin}/connect`,errorCallbackURL:`${config.origin}/sign-in`,...(query?{oauth_query:query}:{})});
  const current=await ownerSession(auth,config,request);
  if(path==='/ui/sign-out'){const response=await forward(request,'/sign-out',{});if(!response.ok)return response;const headers=new Headers(response.headers);headers.delete('content-length');return noStore(Response.json({url:'/sign-in'},{headers}));}
  if(path==='/ui/consent'){await signed(query);if(typeof input.accept!=='boolean')throw new AppError('INVALID_REQUEST');return forward(request,'/oauth2/consent',{accept:input.accept,oauth_query:query});}
  if(path==='/ui/analytics-consent')return noStore(Response.json({url:await providers.begin(current.user.id,current.session.id,'youtube',true)}));
  if(path==='/ui/provider')return noStore(Response.json({url:await providers.begin(current.user.id,current.session.id,provider(input.provider))}));
  const service=new Service(providers,current.user.id);
  const {oauth_query:ignored,...fields}=input;
  if(path==='/ui/analytics-status')return noStore(Response.json(await service.analytics.status()));
  if(path==='/ui/analytics-report'){if(fields.videoId==='')delete fields.videoId;return noStore(Response.json(await service.analytics.report(analyticsInput.parse(fields))));}
  if(path==='/ui/reporting-types')return noStore(Response.json(await service.analytics.types(reportingPageInput.parse(fields))));
  if(path==='/ui/reporting-jobs')return noStore(Response.json(await service.analytics.jobs(reportingPageInput.parse(fields))));
  if(path==='/ui/reporting-enable')return noStore(Response.json(await service.analytics.enable(reportingEnableInput.parse(fields))));
  if(path==='/ui/reporting-reports')return noStore(Response.json(await service.analytics.reports(reportingJobInput.parse(fields))));
  if(path==='/ui/reporting-csv')return noStore(Response.json(await service.analytics.csv(reportingCsvInput.parse(fields))));
  if(path==='/ui/upload'){const {oauth_query,...fields}=input;const validated=z.strictObject(uploadShape).parse(fields);return noStore(Response.json(await service.uploads.create(current.user.id,validated)));}
  if(path==='/ui/upload-step'){const jobId=z.uuid().parse(input.jobId);return noStore(Response.json(await service.uploads.advance(current.user.id,jobId)));}
  throw new AppError('NOT_FOUND',404);
 };
}
