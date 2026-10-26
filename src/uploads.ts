import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {AppError,errorCode} from './config.ts';
import {Providers} from './providers.ts';
import {googleError,googleUrl,jsonResponse,readBounded} from './http.ts';
export const CHUNK_BYTES=8*1024*1024;
export interface UploadInput {title:string;description?:string|undefined;tags?:string[]|undefined;categoryId?:string|undefined;privacyStatus:'private'|'unlisted'|'public';publishAt?:string|undefined;madeForKids?:boolean|undefined;containsSyntheticMedia?:boolean|undefined}
export function validateUploadMetadata(input:UploadInput){
 if(typeof input.title!=='string'||!input.title.trim()||[...input.title].length>100||/[<>]/.test(input.title))throw new AppError('INVALID_TITLE');
 if(!['private','unlisted','public'].includes(input.privacyStatus))throw new AppError('PRIVACY_STATUS_REQUIRED');
 if(input.description!==undefined&&(typeof input.description!=='string'||Buffer.byteLength(input.description)>5000))throw new AppError('INVALID_DESCRIPTION');
 if(input.tags!==undefined&&(!Array.isArray(input.tags)||input.tags.some(t=>typeof t!=='string'||!t.trim())||input.tags.join(',').length>450))throw new AppError('INVALID_TAGS');
 if(input.publishAt&&(input.privacyStatus!=='private'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(input.publishAt)||!Number.isFinite(Date.parse(input.publishAt))||Date.parse(input.publishAt)<=Date.now()))throw new AppError('INVALID_PUBLISH_TIME');
 return {snippet:{title:input.title,description:input.description??'',categoryId:input.categoryId??'22',...(input.tags?{tags:input.tags}:{})},status:{privacyStatus:input.privacyStatus,...(input.publishAt?{publishAt:input.publishAt}:{}),...(input.madeForKids!==undefined?{selfDeclaredMadeForKids:input.madeForKids}:{}),...(input.containsSyntheticMedia!==undefined?{containsSyntheticMedia:input.containsSyntheticMedia}:{})}};
}
export function resumeOffset(range:string|null,total:number){if(!range)return 0;const match=/^bytes=0-(\d+)$/.exec(range);const end=match?Number(match[1]):NaN;if(!Number.isSafeInteger(end)||end<0||end>=total)throw new AppError('INVALID_RESUME_OFFSET',502);return end+1;}
export interface UploadRow {id:string;owner_id:string;idempotency_key:string;request_hash:string;drive_file_id:string;source_version:string;source_revision:string;source_md5:string|null;source_size:string|number;mime_type:string;channel_id:string;metadata:ReturnType<typeof validateUploadMetadata>;session_cipher:string|null;offset_bytes:string|number;status:string;video_id:string|null;last_error:string|null}
export function publicJob(row:UploadRow){const total=Number(row.source_size),offset=Number(row.offset_bytes);return {jobId:row.id,status:row.status,driveFileId:row.drive_file_id,channelId:row.channel_id,uploadedBytes:offset,totalBytes:total,percent:Math.floor(offset/total*10000)/100,videoId:row.video_id,videoUrl:row.video_id?`https://www.youtube.com/watch?v=${row.video_id}`:null,lastError:row.last_error};}
export class Uploads {
 readonly pool:Pool;readonly providers:Providers;
 constructor(pool:Pool,providers:Providers){this.pool=pool;this.providers=providers;}
 async source(ownerId:string,fileId:string){if(!/^[A-Za-z0-9_-]{1,256}$/.test(fileId))throw new AppError('INVALID_DRIVE_FILE_ID');const fields='id,name,mimeType,size,version,md5Checksum,headRevisionId,capabilities(canDownload)';const body=await jsonResponse(await this.providers.request(ownerId,'drive',`https://www.googleapis.com/drive/v3/files/${fileId}?fields=${encodeURIComponent(fields)}&supportsAllDrives=true`));const size=Number(body.size);if(!body.mimeType?.startsWith('video/')||!Number.isSafeInteger(size)||size<=0||!body.version||!body.headRevisionId||body.capabilities?.canDownload!==true)throw new AppError('DRIVE_VIDEO_NOT_DOWNLOADABLE');return body;}
 async create(ownerId:string,input:UploadInput&{driveFileId:string;idempotencyKey:string}){
  if(!/^[A-Za-z0-9_.:-]{1,160}$/.test(input.idempotencyKey))throw new AppError('INVALID_IDEMPOTENCY_KEY');const metadata=validateUploadMetadata(input);const hash=createHash('sha256').update(JSON.stringify({driveFileId:input.driveFileId,metadata})).digest('hex');
  const previous=(await this.pool.query<UploadRow>('SELECT * FROM upload_jobs WHERE owner_id=$1 AND idempotency_key=$2',[ownerId,input.idempotencyKey])).rows[0];if(previous){if(previous.request_hash!==hash)throw new AppError('IDEMPOTENCY_CONFLICT',409);return publicJob(previous);}
  const channel=await this.providers.requireChannel(ownerId);const source=await this.source(ownerId,input.driveFileId);const id=randomUUID();
  const inserted=await this.pool.query<UploadRow>(`INSERT INTO upload_jobs(id,owner_id,idempotency_key,request_hash,drive_file_id,source_version,source_revision,source_md5,source_size,mime_type,channel_id,metadata,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'created') ON CONFLICT(owner_id,idempotency_key) DO NOTHING RETURNING *`,[id,ownerId,input.idempotencyKey,hash,input.driveFileId,String(source.version),source.headRevisionId,source.md5Checksum??null,source.size,source.mimeType,channel.channel_id,JSON.stringify(metadata)]);
  const row=inserted.rows[0]??(await this.pool.query<UploadRow>('SELECT * FROM upload_jobs WHERE owner_id=$1 AND idempotency_key=$2',[ownerId,input.idempotencyKey])).rows[0]!;if(row.request_hash!==hash)throw new AppError('IDEMPOTENCY_CONFLICT',409);return publicJob(row);
 }
 async status(ownerId:string,jobId:string){const row=(await this.pool.query<UploadRow>('SELECT * FROM upload_jobs WHERE owner_id=$1 AND id=$2',[ownerId,jobId])).rows[0];if(!row)throw new AppError('UPLOAD_JOB_NOT_FOUND',404);return publicJob(row);}
 async #complete(db:PoolClient,row:UploadRow,response:Response){const body=await jsonResponse(response);if(typeof body.id!=='string'||body.snippet?.channelId!==row.channel_id)throw new AppError('UPLOAD_RESULT_CHANNEL_MISMATCH',502);await db.query(`UPDATE upload_jobs SET status='complete',video_id=$3,offset_bytes=source_size,last_error=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2`,[row.owner_id,row.id,body.id]);row.status='complete';row.video_id=body.id;row.offset_bytes=row.source_size;row.last_error=null;}
 async advance(ownerId:string,jobId:string){
  // Refresh outside the job transaction: provider refresh uses its own row lock.
  await this.providers.token(ownerId,'drive');await this.providers.token(ownerId,'youtube');
  const db=await this.pool.connect();let row:UploadRow|undefined;
  try{await db.query('BEGIN');
   // A single owner's transfers share one nonblocking lock. Contenders release their pool
   // connection immediately, leaving capacity for the independently committed token vault.
   const lock=(await db.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked',[`youtube-drive:${ownerId}`])).rows[0];if(!lock?.locked)throw new AppError('UPLOAD_BUSY_RETRY_SAME_JOB',409);
   row=(await db.query<UploadRow>('SELECT * FROM upload_jobs WHERE owner_id=$1 AND id=$2 FOR UPDATE',[ownerId,jobId])).rows[0];if(!row)throw new AppError('UPLOAD_JOB_NOT_FOUND',404);if(row.status==='complete'){await db.query('COMMIT');return publicJob(row);}if(!['created','uploading'].includes(row.status))throw new AppError('UPLOAD_REQUIRES_ATTENTION',409);
   const channel=await this.providers.requireChannel(ownerId);if(row.channel_id!==channel.channel_id)throw new AppError('YOUTUBE_CHANNEL_MISMATCH',403);const source=await this.source(ownerId,row.drive_file_id);if(String(source.version)!==row.source_version||source.headRevisionId!==row.source_revision||Number(source.size)!==Number(row.source_size)||String(source.md5Checksum??'')!==String(row.source_md5??'')){row.status='source_changed';throw new AppError('UPLOAD_SOURCE_CHANGED',409);}
   const total=Number(row.source_size);
   if(!row.session_cipher){
    // This creates a resumable session, not a completed video. If its response is lost, stop before bytes are sent.
    let response:Response;try{response=await this.providers.request(ownerId,'youtube','https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=false',{method:'POST',headers:{'Content-Type':'application/json; charset=utf-8','X-Upload-Content-Length':String(total),'X-Upload-Content-Type':row.mime_type},body:JSON.stringify(row.metadata)});}catch{row.status='initialization_uncertain';throw new AppError('UPLOAD_INITIALIZATION_UNCERTAIN',409);}
    if(!response.ok)await googleError(response);const location=response.headers.get('location');await response.body?.cancel();if(!location)throw new AppError('UPLOAD_SESSION_MISSING',502);const session=googleUrl(location);row.session_cipher=this.providers.cipher.seal(session,`upload:${ownerId}:${row.id}`);row.status='uploading';await db.query(`UPDATE upload_jobs SET session_cipher=$3,status='uploading',updated_at=now() WHERE owner_id=$1 AND id=$2`,[ownerId,row.id,row.session_cipher]);
    // Commit the session URL before any video bytes leave. Later timeouts can always probe this same session.
    await db.query('COMMIT');return publicJob(row);
   }
   const session=googleUrl(this.providers.cipher.open(row.session_cipher,`upload:${ownerId}:${row.id}`));
   const probe=await this.providers.request(ownerId,'youtube',session,{method:'PUT',headers:{'Content-Length':'0','Content-Range':`bytes */${total}`}});
   if(probe.status===200||probe.status===201){await this.#complete(db,row,probe);await db.query('COMMIT');return publicJob(row);}
   if(probe.status===404||probe.status===410){row.status='session_expired';await probe.body?.cancel();throw new AppError('UPLOAD_SESSION_EXPIRED',409);}if(probe.status!==308)await googleError(probe);const offset=resumeOffset(probe.headers.get('range'),total);await probe.body?.cancel();row.offset_bytes=offset;
   if(offset===total)throw new AppError('UPLOAD_COMPLETION_PENDING',503);
   const end=Math.min(total-1,offset+CHUNK_BYTES-1);const mediaUrl=`https://www.googleapis.com/drive/v3/files/${row.drive_file_id}/revisions/${encodeURIComponent(row.source_revision)}?alt=media`;const media=await this.providers.request(ownerId,'drive',mediaUrl,{headers:{Range:`bytes=${offset}-${end}`}});
   if(media.status!==206||media.headers.get('content-range')!==`bytes ${offset}-${end}/${total}`){if(!media.ok)await googleError(media);await media.body?.cancel();throw new AppError('DRIVE_RANGE_MISMATCH',502);}const bytes=await readBounded(media.body,CHUNK_BYTES);if(bytes.byteLength!==end-offset+1)throw new AppError('DRIVE_RANGE_MISMATCH',502);
   const sent=await this.providers.request(ownerId,'youtube',session,{method:'PUT',headers:{'Content-Type':row.mime_type,'Content-Length':String(bytes.byteLength),'Content-Range':`bytes ${offset}-${end}/${total}`},body:new Uint8Array(bytes).buffer});
   if(sent.status===200||sent.status===201)await this.#complete(db,row,sent);else if(sent.status===308){row.offset_bytes=resumeOffset(sent.headers.get('range'),total);await sent.body?.cancel();if(Number(row.offset_bytes)<offset||Number(row.offset_bytes)>end+1)throw new AppError('INVALID_RESUME_OFFSET',502);await db.query(`UPDATE upload_jobs SET offset_bytes=$3,last_error=NULL,updated_at=now() WHERE owner_id=$1 AND id=$2`,[ownerId,row.id,row.offset_bytes]);row.last_error=null;}else await googleError(sent);
   await db.query('COMMIT');return publicJob(row);
  }catch(error){if(row){const code=errorCode(error);await db.query(`UPDATE upload_jobs SET status=$3,last_error=$4,updated_at=now() WHERE owner_id=$1 AND id=$2`,[ownerId,row.id,row.status,code]);await db.query('COMMIT');}else await db.query('ROLLBACK');if(error instanceof AppError)throw error;throw new AppError('UPLOAD_RETRY_SAME_JOB',503);}finally{db.release();}
 }
}
