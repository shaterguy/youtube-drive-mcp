import {OAuth2Client} from 'google-auth-library';
import type {Pool,PoolClient} from 'pg';
import {AppError,PROVIDER_SCOPES,ANALYTICS_SCOPES,type Config,type Provider} from './config.ts';
import {VaultCipher,digest,random} from './crypto.ts';
import {googleError,jsonResponse} from './http.ts';

export interface ConnectionRow { owner_id:string;provider:Provider;subject:string;email:string;scopes:string[];access_cipher:string;refresh_cipher:string;expires_at:Date;refresh_expires_at:Date|null;channel_id:string|null;channel_title:string|null;channel_uploads:string|null;auth_state:string;last_refresh_at:Date|null }
export class Providers {
 readonly pool:Pool;readonly config:Config;readonly cipher:VaultCipher;readonly fetch:typeof fetch;
 constructor(pool:Pool,config:Config,fetcher:typeof fetch=fetch){this.pool=pool;this.config=config;this.cipher=new VaultCipher(config.encryptionKey);this.fetch=fetcher;}
 context(ownerId:string,p:Provider){return `provider:${ownerId}:${p}`;}
 async list(ownerId:string){const r=await this.pool.query(`SELECT provider,email,subject,scopes,expires_at,refresh_expires_at,channel_id,channel_title,auth_state,last_refresh_at FROM provider_connections WHERE owner_id=$1 ORDER BY provider`,[ownerId]);return r.rows;}
 async connection(ownerId:string,p:Provider):Promise<ConnectionRow>{const r=await this.pool.query<ConnectionRow>('SELECT * FROM provider_connections WHERE owner_id=$1 AND provider=$2',[ownerId,p]);if(!r.rows[0])throw new AppError(`${p.toUpperCase()}_NOT_CONNECTED`,409);return r.rows[0];}
 async begin(ownerId:string,sessionId:string,p:Provider,analytics=false):Promise<string>{
  const original=analytics?await this.requireChannel(ownerId):undefined;if(analytics&&p!=='youtube')throw new AppError('INVALID_PROVIDER');
  const state=random(),verifier=random(),nonce=random();
  await this.pool.query('DELETE FROM provider_states WHERE owner_id=$1 AND expires_at<now()',[ownerId]);
  await this.pool.query(`INSERT INTO provider_states(state_hash,owner_id,session_id,provider,verifier_cipher,nonce,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '10 minutes')`,[digest(state),ownerId,sessionId,p,this.cipher.seal(analytics?JSON.stringify({verifier,analytics:true,subject:original!.subject}):verifier,`state:${digest(state)}`),nonce]);
  const u=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search=new URLSearchParams({client_id:this.config.googleAgentClientId,redirect_uri:`${this.config.origin}/google/callback`,response_type:'code',scope:[...PROVIDER_SCOPES[p],...(analytics?ANALYTICS_SCOPES:[])].join(' '),state,nonce,code_challenge:digest(verifier),code_challenge_method:'S256',access_type:'offline',prompt:'select_account consent',include_granted_scopes:'true',...(p==='drive'?{login_hint:this.config.ownerEmail}:{})}).toString();return u.href;
 }
 async complete(ownerId:string,sessionId:string,state:string,code:string):Promise<Provider>{
  // Consume before exchanging: replayed callbacks cannot replace a stored credential.
  const r=await this.pool.query<{provider:Provider;verifier_cipher:string;nonce:string}>(`DELETE FROM provider_states WHERE state_hash=$1 AND owner_id=$2 AND session_id=$3 AND expires_at>now() RETURNING *`,[digest(state),ownerId,sessionId]);const row=r.rows[0];if(!row)throw new AppError('INVALID_OAUTH_STATE');
  const stored=this.cipher.open(row.verifier_cipher,`state:${digest(state)}`);let consent:{verifier:string;analytics?:boolean;subject?:string}={verifier:stored};if(stored.startsWith('{')){try{consent=JSON.parse(stored);}catch{throw new AppError('INVALID_OAUTH_STATE');}if(typeof consent.verifier!=='string'||consent.analytics!==true||typeof consent.subject!=='string'||row.provider!=='youtube')throw new AppError('INVALID_OAUTH_STATE');}
  const oauth=new OAuth2Client({clientId:this.config.googleAgentClientId,clientSecret:this.config.googleAgentClientSecret});
  let tokens;try{tokens=(await oauth.getToken({code,codeVerifier:consent.verifier,redirect_uri:`${this.config.origin}/google/callback`})).tokens;}catch{throw new AppError('GOOGLE_TOKEN_EXCHANGE_FAILED',409);}
  if(!tokens.id_token||!tokens.access_token||!tokens.expiry_date)throw new AppError('GOOGLE_PARTIAL_GRANT',409);
  let payload;try{payload=(await oauth.verifyIdToken({idToken:tokens.id_token,audience:this.config.googleAgentClientId})).getPayload();}catch{throw new AppError('GOOGLE_IDENTITY_INVALID',409);}
  if(!payload||payload.nonce!==row.nonce||payload.email_verified!==true||!payload.email||!payload.sub)throw new AppError('GOOGLE_IDENTITY_INVALID',409);
  if(row.provider==='drive'&&payload.email.toLowerCase()!==this.config.ownerEmail)throw new AppError('DRIVE_OWNER_MISMATCH',403);
  const scopes=(tokens.scope??'').split(' ');const required=[...PROVIDER_SCOPES[row.provider].filter(s=>s.startsWith('https://')),...(consent.analytics?ANALYTICS_SCOPES:[])];if(!required.every(s=>scopes.includes(s)))throw new AppError('GOOGLE_PARTIAL_GRANT',409);
  let channelId:string|null=null,channelTitle:string|null=null,uploads:string|null=null;
  if(row.provider==='youtube'){
   const result=await jsonResponse(await this.fetch('https://www.googleapis.com/youtube/v3/channels?part=id,snippet,contentDetails&mine=true',{headers:{Authorization:`Bearer ${tokens.access_token}`},redirect:'error',signal:AbortSignal.timeout(20000)}));
   const channel=result.items?.find((x:any)=>x.id===this.config.youtubeChannelId);if(!channel)throw new AppError('YOUTUBE_CHANNEL_MISMATCH',403);channelId=channel.id;channelTitle=channel.snippet?.title??channelId;uploads=channel.contentDetails?.relatedPlaylists?.uploads??null;
  }
  const db=await this.pool.connect();try{await db.query('BEGIN');const old=(await db.query<ConnectionRow>('SELECT * FROM provider_connections WHERE owner_id=$1 AND provider=$2 FOR UPDATE',[ownerId,row.provider])).rows[0];
   if(row.provider==='youtube'&&(consent.analytics||old?.scopes.some(s=>(ANALYTICS_SCOPES as readonly string[]).includes(s)))){if(!old||old.subject!==payload.sub||(consent.subject&&consent.subject!==payload.sub))throw new AppError('YOUTUBE_SUBJECT_MISMATCH',403);}
   const previous=old&&old.subject===payload.sub?this.cipher.open(old.refresh_cipher,this.context(ownerId,row.provider)):undefined;
   const refresh=tokens.refresh_token??previous;if(!refresh)throw new AppError('GOOGLE_OFFLINE_GRANT_REQUIRED',409);
   const ctx=this.context(ownerId,row.provider);
   const initialExpiry=(tokens as unknown as Record<string,unknown>).refresh_token_expires_in;
   const refreshExpiry=typeof initialExpiry==='number'&&Number.isFinite(initialExpiry)?new Date(Date.now()+initialExpiry*1000):(!tokens.refresh_token&&old?.subject===payload.sub?old.refresh_expires_at:null);
   await db.query(`INSERT INTO provider_connections(owner_id,provider,subject,email,scopes,access_cipher,refresh_cipher,expires_at,channel_id,channel_title,channel_uploads,refresh_expires_at,auth_state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active') ON CONFLICT(owner_id,provider) DO UPDATE SET subject=EXCLUDED.subject,email=EXCLUDED.email,scopes=EXCLUDED.scopes,access_cipher=EXCLUDED.access_cipher,refresh_cipher=EXCLUDED.refresh_cipher,expires_at=EXCLUDED.expires_at,refresh_expires_at=EXCLUDED.refresh_expires_at,channel_id=EXCLUDED.channel_id,channel_title=EXCLUDED.channel_title,channel_uploads=EXCLUDED.channel_uploads,auth_state='active',updated_at=now()`,[ownerId,row.provider,payload.sub,payload.email,JSON.stringify(scopes),this.cipher.seal(tokens.access_token,ctx),this.cipher.seal(refresh,ctx),new Date(tokens.expiry_date),channelId,channelTitle,uploads,refreshExpiry]);await db.query('COMMIT');return row.provider;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async token(ownerId:string,p:Provider,force=false,rejectedToken?:string):Promise<string>{
  const db=await this.pool.connect();let committed=false;try{await db.query('BEGIN');const r=await db.query<ConnectionRow>('SELECT * FROM provider_connections WHERE owner_id=$1 AND provider=$2 FOR UPDATE',[ownerId,p]);const row=r.rows[0];if(!row)throw new AppError(`${p.toUpperCase()}_NOT_CONNECTED`,409);if(row.auth_state!=='active')throw new AppError('GOOGLE_REAUTH_REQUIRED',409);
   const ctx=this.context(ownerId,p);const currentToken=this.cipher.open(row.access_cipher,ctx);
   if(new Date(row.expires_at).getTime()>Date.now()+300000&&(!force||(rejectedToken!==undefined&&currentToken!==rejectedToken))){await db.query('COMMIT');committed=true;return currentToken;}
   let response:Response;try{response=await this.fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:this.config.googleAgentClientId,client_secret:this.config.googleAgentClientSecret,grant_type:'refresh_token',refresh_token:this.cipher.open(row.refresh_cipher,ctx)}),redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw new AppError('GOOGLE_TEMPORARILY_UNAVAILABLE',503);}
   let result:any;try{result=await response.json();}catch{throw new AppError('GOOGLE_TEMPORARILY_UNAVAILABLE',503);}
   if(!response.ok){if(result.error==='invalid_grant'){await db.query(`UPDATE provider_connections SET auth_state='reauth_required',updated_at=now() WHERE owner_id=$1 AND provider=$2`,[ownerId,p]);await db.query('COMMIT');committed=true;throw new AppError('GOOGLE_REAUTH_REQUIRED',409);}if(response.status===429)throw new AppError('GOOGLE_QUOTA_OR_RATE_LIMIT',429);throw new AppError('GOOGLE_TEMPORARILY_UNAVAILABLE',503);}
   if(typeof result.access_token!=='string'||!Number.isFinite(result.expires_in)||result.expires_in<=0)throw new AppError('GOOGLE_TEMPORARILY_UNAVAILABLE',503);
   let scopes=row.scopes;
   if(Object.hasOwn(result,'scope')){
    if(typeof result.scope!=='string'||result.scope.length>16384)throw new AppError('GOOGLE_TEMPORARILY_UNAVAILABLE',503);
    scopes=[...new Set<string>(result.scope.split(' ').filter(Boolean))];
    if(scopes.some(scope=>!/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope)))throw new AppError('GOOGLE_TEMPORARILY_UNAVAILABLE',503);
   }
   const refresh=typeof result.refresh_token==='string'&&result.refresh_token?this.cipher.seal(result.refresh_token,ctx):row.refresh_cipher;
   const refreshExpires=Number.isFinite(result.refresh_token_expires_in)?new Date(Date.now()+result.refresh_token_expires_in*1000):row.refresh_expires_at;
   await db.query(`UPDATE provider_connections SET access_cipher=$3,refresh_cipher=$4,expires_at=$5,refresh_expires_at=$6,scopes=$7,last_refresh_at=now(),updated_at=now() WHERE owner_id=$1 AND provider=$2`,[ownerId,p,this.cipher.seal(result.access_token,ctx),refresh,new Date(Date.now()+result.expires_in*1000),refreshExpires,JSON.stringify(scopes)]);await db.query('COMMIT');committed=true;return result.access_token;
  }catch(error){if(!committed)await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async request(ownerId:string,p:Provider,url:string,init:RequestInit={}):Promise<Response>{
  const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||u.port||!['www.googleapis.com','youtubeanalytics.googleapis.com','youtubereporting.googleapis.com'].includes(u.hostname))throw new AppError('INVALID_GOOGLE_ENDPOINT');
  const send=async(token:string)=>{const headers=new Headers(init.headers);headers.set('Authorization',`Bearer ${token}`);return this.fetch(u.href,{...init,headers,redirect:u.hostname==='www.googleapis.com'&&u.pathname==='/upload/youtube/v3/videos'&&init.method==='PUT'?'manual':'error',signal:AbortSignal.timeout(45000)});};
  const token=await this.token(ownerId,p);let response=await send(token);if(response.status===401){await response.body?.cancel();response=await send(await this.token(ownerId,p,true,token));}return response;
 }
 async requireChannel(ownerId:string){const row=await this.connection(ownerId,'youtube');if(row.channel_id!==this.config.youtubeChannelId)throw new AppError('YOUTUBE_CHANNEL_MISMATCH',403);return row;}
}
