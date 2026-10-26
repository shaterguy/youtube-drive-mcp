import {randomBytes} from 'node:crypto';
import {verifyOAuthQueryParams} from '@better-auth/oauth-provider';
import {ownerSession,type Auth} from './auth.ts';
import {AppError,MCP_SCOPES,noStore,provider,type Config} from './config.ts';
import {bounded} from './http.ts';
import {Providers} from './providers.ts';
import {Service} from './service.ts';
import {uploadShape} from './mcp.ts';
import * as z from 'zod/v4';
const escape=(v:unknown)=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function page(title:string,body:string,oauthQuery=''){
 const nonce=randomBytes(18).toString('base64');
 const script=`const oq=${JSON.stringify(oauthQuery).replace(/</g,'\\u003c')};const out=document.getElementById('status');
 async function post(path,body){const response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,oauth_query:oq})});const data=await response.json();if(!response.ok)throw Error(data.error||'REQUEST_FAILED');return data;}
 async function transfer(job){out.textContent=JSON.stringify(job,null,2);while(job.status==='created'||job.status==='uploading'){await new Promise(r=>setTimeout(r,100));job=await post('/ui/upload-step',{jobId:job.jobId});out.textContent=JSON.stringify(job,null,2);}return job;}
 document.querySelectorAll('form').forEach(form=>form.addEventListener('submit',async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;out.textContent='처리 중입니다.';try{const body=Object.fromEntries(new FormData(form));if(button.name)body[button.name]=button.value;if('accept'in body)body.accept=body.accept==='true';const data=await post(form.action,body);if(data.jobId)await transfer(data);else if(data.url){const u=new URL(data.url,location.origin);if(u.protocol!=='https:')throw Error('INVALID_REDIRECT');location.assign(u.href);}else out.textContent=JSON.stringify(data,null,2);}catch(error){out.textContent=error.message+' — 같은 작업 ID로 다시 진행할 수 있습니다.';}finally{button.disabled=false;}}));`;
 return noStore(new Response(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style nonce="${nonce}">body{font:16px system-ui,sans-serif;background:#f5f6f8;color:#17202a;margin:0}main{max-width:860px;margin:40px auto;padding:28px;background:white;border-radius:12px}h1{font-size:28px}section{border-top:1px solid #ddd;padding:20px 0}label{display:block;margin:12px 0}input,textarea,select,button{font:inherit;padding:10px;max-width:100%;box-sizing:border-box}input,textarea{width:100%}button{cursor:pointer;background:#143f65;color:white;border:0;border-radius:6px}pre{white-space:pre-wrap;overflow-wrap:anywhere}form{margin:12px 0}small{color:#52606d}</style></head><body><main><h1>${escape(title)}</h1>${body}<pre id="status" role="status"></pre></main><script nonce="${nonce}">${script}</script></body></html>`,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`}}));
}
export function createUi(auth:Auth,config:Config,providers:Providers){
 async function signed(query:unknown,optional=false){if(optional&&(query===undefined||query===''))return '';if(typeof query!=='string'||query.length>16384||!await verifyOAuthQueryParams(query,(await auth.$context).secret))throw new AppError('INVALID_AUTHORIZATION_REQUEST');return query;}
 async function forward(request:Request,path:string,body:Record<string,unknown>){const headers=new Headers(request.headers);headers.set('Content-Type','application/json');headers.delete('content-length');return noStore(await auth.handler(new Request(`${config.issuer}${path}`,{method:'POST',headers,body:JSON.stringify(body)})));}
 return async(request:Request):Promise<Response>=>{
  const u=new URL(request.url);const path=u.pathname;
  if(request.method==='GET'){
   if(path==='/'||path==='/sign-in'){
    const errorOnly=[...u.searchParams.keys()].every(k=>['error','error_description'].includes(k));const query=await signed(errorOnly?'':u.search.slice(1),true);
    return page('YouTube Drive MCP',`<p>MCP 로그인 계정은 <strong>${escape(config.ownerEmail)}</strong>입니다. Drive와 YouTube의 서비스 연결은 로그인 후 각각 설정합니다.</p><form action="/ui/sign-in"><button>메인계정으로 Google 로그인</button></form><p><small>ChatGPT MCP 주소: ${escape(config.resource)}</small></p>`,query);
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
    return page('계정 연결과 영상 전송',`<p>로그인: ${escape(current.user.email)}</p>${cards}<section><h2>Drive 영상 업로드</h2><p>메인계정 Drive에서 읽어 채널계정의 지정 채널로 전송합니다. 이 페이지가 열려 있으면 청크를 자동으로 이어서 전송합니다.</p><form action="/ui/upload"><label>Drive 파일 ID<input name="driveFileId" required></label><label>중복 방지 키<input name="idempotencyKey" placeholder="한 영상 업로드에 계속 같은 값을 사용합니다." required></label><label>영상 제목<input name="title" maxlength="100" required></label><label>설명<textarea name="description" rows="4"></textarea></label><label>공개 상태<select name="privacyStatus"><option value="private">비공개</option><option value="unlisted">일부 공개</option><option value="public">공개</option></select></label><button>영상 전송 시작</button></form><form action="/ui/upload-step"><label>중단된 작업 ID<input name="jobId" required></label><button>같은 작업 이어서 전송</button></form></section><section><p>Google에서 권한을 철회하거나 기간 제한 승인이 만료되면 해당 서비스 연결만 다시 승인하면 됩니다. MCP 연결과 저장된 전송 작업은 유지됩니다.</p><form action="/ui/sign-out"><button>이 웹페이지에서 로그아웃</button></form></section>`);
   }
  }
  if(request.method!=='POST'||request.headers.get('origin')!==config.origin||!request.headers.get('content-type')?.startsWith('application/json'))throw new AppError('INVALID_ORIGIN');
  const input=await (await bounded(request,32768)).json() as Record<string,unknown>;if(!input||typeof input!=='object'||Array.isArray(input))throw new AppError('INVALID_REQUEST');
  const query=await signed(input.oauth_query,true);
  if(path==='/ui/sign-in')return forward(request,'/sign-in/social',{provider:'google',callbackURL:`${config.origin}/connect`,errorCallbackURL:`${config.origin}/sign-in`,...(query?{oauth_query:query}:{})});
  const current=await ownerSession(auth,config,request);
  if(path==='/ui/sign-out'){const response=await forward(request,'/sign-out',{});if(!response.ok)return response;const headers=new Headers(response.headers);headers.delete('content-length');return noStore(Response.json({url:'/sign-in'},{headers}));}
  if(path==='/ui/consent'){await signed(query);if(typeof input.accept!=='boolean')throw new AppError('INVALID_REQUEST');return forward(request,'/oauth2/consent',{accept:input.accept,oauth_query:query});}
  if(path==='/ui/provider')return noStore(Response.json({url:await providers.begin(current.user.id,current.session.id,provider(input.provider))}));
  const service=new Service(providers,current.user.id);
  if(path==='/ui/upload'){const {oauth_query,...fields}=input;const validated=z.strictObject(uploadShape).parse(fields);return noStore(Response.json(await service.uploads.create(current.user.id,validated)));}
  if(path==='/ui/upload-step'){const jobId=z.uuid().parse(input.jobId);return noStore(Response.json(await service.uploads.advance(current.user.id,jobId)));}
  throw new AppError('NOT_FOUND',404);
 };
}
