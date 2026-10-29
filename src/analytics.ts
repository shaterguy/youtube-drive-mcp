import * as z from 'zod/v4';
import {AppError,ANALYTICS_SCOPES} from './config.ts';
import {Providers} from './providers.ts';
import {googleError,jsonResponse,readBounded} from './http.ts';

const calendar=(s:string)=>/^\d{4}-\d{2}-\d{2}$/.test(s)&&s>='2005-01-01'&&new Date(s+'T00:00:00Z').toISOString().slice(0,10)===s;
const day=z.string().refine(s=>{try{return calendar(s);}catch{return false;}},'Invalid ISO calendar day');
const id=z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
export const analyticsInput=z.strictObject({profile:z.enum(['summary','daily','videos','traffic','retention']),startDate:day,endDate:day,videoId:z.string().regex(/^[A-Za-z0-9_-]{11}$/).optional()}).superRefine((v,ctx)=>{
 if(v.startDate>v.endDate||Date.parse(v.endDate)-Date.parse(v.startDate)>366*86400000)ctx.addIssue({code:'custom',message:'Date range must be ordered and at most 367 reporting days'});
 if(v.profile==='retention'&&!v.videoId)ctx.addIssue({code:'custom',message:'Retention requires a single videoId'});
 if(v.profile==='videos'&&v.videoId)ctx.addIssue({code:'custom',message:'Top videos cannot filter a single video'});
});
export const reportingPageInput=z.strictObject({pageToken:z.string().max(2048).optional()});
export const reportingJobInput=reportingPageInput.extend({jobId:id});
const reportingType=/^channel_(reach_(basic|combined)|end_screens|cards)_a\d+$/;
export const reportingEnableInput=z.strictObject({reportTypeId:z.string().regex(reportingType)});
export const reportingCsvInput=z.strictObject({jobId:id,reportId:id,rowLimit:z.number().int().min(1).max(500).optional()});
const base='https://youtubereporting.googleapis.com/v1';
const supported=(t:Record<string,any>)=>reportingType.test(t.id??'')&&!t.deprecateTime&&!t.systemManaged;
const cleanJob=(j:Record<string,any>)=>({id:j.id,reportTypeId:j.reportTypeId,name:j.name,createTime:j.createTime,expireTime:j.expireTime});
const cleanReport=(r:Record<string,any>)=>({id:r.id,jobId:r.jobId,startTime:r.startTime,endTime:r.endTime,createTime:r.createTime,jobExpireTime:r.jobExpireTime});
const time=()=>({sourceTimezone:'America/Los_Angeles',capturedAt:new Date().toISOString(),reportingDayNote:'Pacific reporting days are not Korean calendar days.'});

export function reportingDownloadUrl(value:unknown,channel:string,jobId:string,reportId:string):string{
 if(typeof value!=='string'||value.length>1000)throw new AppError('INVALID_REPORT_DOWNLOAD');
 let u:URL;try{u=new URL(value);}catch{throw new AppError('INVALID_REPORT_DOWNLOAD');}
 const path='/v1/media/CHANNEL/'+channel.slice(2)+'/jobs/'+jobId+'/reports/'+reportId;
 if(u.origin!=='https://youtubereporting.googleapis.com'||u.username||u.password||u.hash||u.pathname!==path||u.search!=='?alt=media'||value!==u.href)throw new AppError('INVALID_REPORT_DOWNLOAD');
 return u.href;
}
export function parseReportCsv(text:string,rowLimit:number){
 const records:string[][]=[];let record:string[]=[],field='',quoted=false,closed=false;
 const add=()=>{record.push(field);field='';closed=false;if(record.length>100)throw new AppError('REPORT_CSV_TOO_MANY_COLUMNS');};
 const end=()=>{add();records.push(record);record=[];if(records.length>20001)throw new AppError('REPORT_CSV_TOO_MANY_ROWS',413);};
 text=text.replace(/^\uFEFF/,'');
 for(let i=0;i<text.length;i++){
  const c=text[i]!;
  if(quoted){if(c==='"'){if(text[i+1]==='"'){field+='"';i++;}else{quoted=false;closed=true;}}else field+=c;}
  else if(c===',')add();
  else if(c==='\n'||c==='\r'){if(c==='\r'&&text[i+1]==='\n')i++;end();}
  else if(c==='"'){if(field||closed)throw new AppError('INVALID_REPORT_CSV');quoted=true;}
  else{if(closed)throw new AppError('INVALID_REPORT_CSV');field+=c;}
  if(field.length>65536)throw new AppError('REPORT_CSV_FIELD_TOO_LARGE',413);
 }
 if(quoted)throw new AppError('INVALID_REPORT_CSV');
 if(field!==''||closed||record.length)end();
 const headers=records.shift()??[];
 if(!headers.length||headers.some(h=>!h)||new Set(headers).size!==headers.length||records.some(r=>r.length!==headers.length))throw new AppError('INVALID_REPORT_CSV');
 const rows=records.slice(0,rowLimit),truncated=records.length>rowLimit;
 return {headers,rows,returnedRows:rows.length,totalRows:records.length,truncated,complete:!truncated,aggregate:null};
}
export class Analytics{
 readonly providers:Providers;readonly ownerId:string;
 constructor(providers:Providers,ownerId:string){this.providers=providers;this.ownerId=ownerId;}
 async status(){
  let row;try{row=await this.providers.requireChannel(this.ownerId);}catch(error){if(error instanceof AppError&&['YOUTUBE_NOT_CONNECTED','YOUTUBE_CHANNEL_MISMATCH'].includes(error.code))return {ready:false,state:error.code,missingScopes:[...ANALYTICS_SCOPES]};throw error;}
  const missingScopes=ANALYTICS_SCOPES.filter(s=>!row.scopes.includes(s));
  return {ready:!missingScopes.length&&row.auth_state==='active',state:missingScopes.length?'ANALYTICS_AUTH_REQUIRED':row.auth_state==='active'?'ready':'GOOGLE_REAUTH_REQUIRED',missingScopes};
 }
 private async access(){
  await this.providers.requireChannel(this.ownerId);
  await this.providers.token(this.ownerId,'youtube');
  const row=await this.providers.requireChannel(this.ownerId);
  if(ANALYTICS_SCOPES.some(s=>!row.scopes.includes(s)))throw new AppError('ANALYTICS_AUTH_REQUIRED',409);
  const current=await jsonResponse(await this.providers.request(this.ownerId,'youtube','https://www.googleapis.com/youtube/v3/channels?part=id&mine=true'));
  if(!current.items?.some((c:any)=>c.id===this.providers.config.youtubeChannelId))throw new AppError('YOUTUBE_CHANNEL_MISMATCH',403);
 }
 private async response(url:string,init:RequestInit={}){
  const response=await this.providers.request(this.ownerId,'youtube',url,init);
  if(response.status===403){try{await googleError(response);}catch(error){if(error instanceof AppError&&error.code==='GOOGLE_INSUFFICIENT_SCOPE')throw new AppError('ANALYTICS_AUTH_REQUIRED',409);throw error;}}
  return jsonResponse(response);
 }
 async report(raw:unknown){
  const input=analyticsInput.parse(raw);await this.access();
  if(input.videoId){const result=await jsonResponse(await this.providers.request(this.ownerId,'youtube','https://www.googleapis.com/youtube/v3/videos?part=snippet&id='+input.videoId));if(result.items?.[0]?.snippet?.channelId!==this.providers.config.youtubeChannelId)throw new AppError('YOUTUBE_VIDEO_CHANNEL_MISMATCH',403);}
  const metrics='views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,subscribersGained,subscribersLost,likes,comments,shares';
  const profiles:Record<string,Record<string,string>>={
   summary:{metrics},daily:{metrics,dimensions:'day',sort:'day'},
   videos:{metrics:'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage',dimensions:'video',sort:'-views'},
   traffic:{metrics:'views,estimatedMinutesWatched',dimensions:'insightTrafficSourceType',sort:'-views'},
   retention:{metrics:'audienceWatchRatio,relativeRetentionPerformance',dimensions:'elapsedVideoTimeRatio',sort:'elapsedVideoTimeRatio'}
  };
  const limit=input.profile==='videos'?200:500;
  const u=new URL('https://youtubeanalytics.googleapis.com/v2/reports');
  u.search=new URLSearchParams({ids:'channel=='+this.providers.config.youtubeChannelId,startDate:input.startDate,endDate:input.endDate,...profiles[input.profile],maxResults:String(limit),...(input.videoId?{filters:'video=='+input.videoId}:{})}).toString();
  const body=await this.response(u.href);const rows=Array.isArray(body.rows)?body.rows:[],headers=Array.isArray(body.columnHeaders)?body.columnHeaders:[];
  const index=headers.findIndex((h:any)=>h.name==='day');const availableDates:string[]=index<0?[]:[...new Set<string>(rows.map((r:any)=>r[index]).filter((d:any)=>typeof d==='string'&&calendar(d)))].sort();
  return {source:'YouTube Analytics API',...time(),channelId:this.providers.config.youtubeChannelId,profile:input.profile,requestedPeriod:{startDate:input.startDate,endDate:input.endDate},state:rows.length?'available':'empty',columnHeaders:headers,rows,availableDates,dataThrough:availableDates.at(-1)??null,dataThroughReason:index<0?'NO_DAY_DIMENSION':availableDates.length?'OBSERVED_REPORTING_DAYS':'NO_AVAILABLE_ROWS',availablePeriod:availableDates.length?{startDate:availableDates[0],endDate:availableDates.at(-1)}:null,possiblyTruncated:rows.length>=limit,...(input.profile==='retention'?{retentionSampling:'PROVIDER_BINS',exactThirtySecondValueAvailable:false}:{})};
 }
 private async all(path:string,key:string){
  const values:Record<string,any>[]=[];let pageToken:string|undefined;
  for(let i=0;i<10;i++){const u=new URL(base+path);u.search=new URLSearchParams({pageSize:'100',...(pageToken?{pageToken}:{})}).toString();const body=await this.response(u.href);values.push(...(body[key]??[]));pageToken=body.nextPageToken;if(!pageToken)return values;}
  throw new AppError('REPORTING_PAGINATION_LIMIT',413);
 }
 async types(raw:unknown={}){
  reportingPageInput.parse(raw);await this.access();const types=(await this.all('/reportTypes','reportTypes')).filter(supported);
  return {source:'YouTube Reporting API',...time(),reportTypes:types.map(t=>({id:t.id,name:t.name})),state:types.length?'available':'empty'};
 }
 async jobs(raw:unknown={}){
  const input=reportingPageInput.parse(raw);await this.access();const u=new URL(base+'/jobs');u.search=new URLSearchParams({pageSize:'50',...(input.pageToken?{pageToken:input.pageToken}:{})}).toString();const body=await this.response(u.href);
  return {source:'YouTube Reporting API',...time(),channelId:this.providers.config.youtubeChannelId,jobs:(body.jobs??[]).map(cleanJob),nextPageToken:body.nextPageToken??null,state:body.jobs?.length?'available':'empty'};
 }
 async enable(raw:unknown){
  const input=reportingEnableInput.parse(raw);await this.access();
  const db=await this.providers.pool.connect();try{await db.query('BEGIN');
   // A transaction-scoped lock serializes all instances for this owner and report type.
   const lock=await db.query('SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked',['reporting:'+this.ownerId+':'+input.reportTypeId]);if(!lock.rows[0]?.locked)throw new AppError('REPORTING_BUSY_RETRY_SAME_TYPE',409);
   const existing=(await this.all('/jobs','jobs')).find(j=>j.reportTypeId===input.reportTypeId);
   if(existing){const expired=!!existing.expireTime&&Date.parse(existing.expireTime)<=Date.now();await db.query('COMMIT');return {job:cleanJob(existing),alreadyPresent:true,enabled:!expired,state:expired?'expired':'enabled',actionRequired:expired?'Discover current report types and explicitly enable a supported replacement type; this expired job was not recreated.':null,source:'YouTube Reporting API',...time()};}
   const types=await this.all('/reportTypes','reportTypes');if(!types.some(t=>t.id===input.reportTypeId&&supported(t)))throw new AppError('REPORTING_TYPE_UNAVAILABLE',409);
   // No automatic retry: after an uncertain POST the next explicit call lists the provider first.
   const job=await this.response(base+'/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reportTypeId:input.reportTypeId,name:'YouTube Drive MCP '+input.reportTypeId})});
   if(!job.id||job.reportTypeId!==input.reportTypeId)throw new AppError('REPORTING_JOB_MISMATCH',502);
   await db.query('COMMIT');return {job:cleanJob(job),alreadyPresent:false,enabled:true,source:'YouTube Reporting API',...time(),state:'pending'};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 private async job(jobId:string){const job=await this.response(base+'/jobs/'+jobId);if(job.id!==jobId||!reportingType.test(job.reportTypeId??''))throw new AppError('REPORTING_JOB_MISMATCH',403);return job;}
 async reports(raw:unknown){
  const input=reportingJobInput.parse(raw);await this.access();await this.job(input.jobId);
  const u=new URL(base+'/jobs/'+input.jobId+'/reports');u.search=new URLSearchParams({pageSize:'50',...(input.pageToken?{pageToken:input.pageToken}:{})}).toString();
  const body=await this.response(u.href);if((body.reports??[]).some((r:any)=>r.jobId!==input.jobId))throw new AppError('REPORTING_REPORT_MISMATCH',403);
  return {source:'YouTube Reporting API',...time(),jobId:input.jobId,reports:(body.reports??[]).map(cleanReport),nextPageToken:body.nextPageToken??null,state:body.reports?.length?'available':'pending'};
 }
 async csv(raw:unknown){
  const input=reportingCsvInput.parse(raw);await this.access();await this.job(input.jobId);
  const report=await this.response(base+'/jobs/'+input.jobId+'/reports/'+input.reportId);
  if(report.id!==input.reportId||report.jobId!==input.jobId)throw new AppError('REPORTING_REPORT_MISMATCH',403);
  const url=reportingDownloadUrl(report.downloadUrl,this.providers.config.youtubeChannelId,input.jobId,input.reportId);
  const response=await this.providers.request(this.ownerId,'youtube',url);if(!response.ok)await googleError(response);
  const bytes=await readBounded(response.body,1024*1024);let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new AppError('INVALID_REPORT_CSV');}
  const parsed=parseReportCsv(text,input.rowLimit??100);
  return {source:'YouTube Reporting API',...time(),channelId:this.providers.config.youtubeChannelId,report:cleanReport(report),availablePeriod:{startTime:report.startTime??null,endTime:report.endTime??null,endExclusive:true},requestedPeriod:null,state:parsed.totalRows?'available':'empty',...parsed,truncationReason:parsed.truncated?'ROW_LIMIT':null,note:'Rows are not aggregated. A truncated sample is not a complete report or channel total.'};
 }
}
