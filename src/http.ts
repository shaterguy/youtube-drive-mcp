import {AppError,type Config} from './config.ts';
export function assertBoundary(request:Request,config:Config) {
  const u=new URL(request.url);if(u.origin!==config.origin || (request.headers.get('host') && request.headers.get('host')!==u.host)) throw new AppError('INVALID_HOST');
  const origin=request.headers.get('origin');if(origin && origin!==config.origin) throw new AppError('INVALID_ORIGIN');
}
export async function bounded(request:Request,max=65536):Promise<Request> {
  const bytes=await readBounded(request.body,max);return new Request(request.url,{method:request.method,headers:request.headers,...(!['GET','HEAD'].includes(request.method)?{body:new Uint8Array(bytes).buffer}:{} )});
}
export async function readBounded(stream:ReadableStream<Uint8Array>|null,max:number):Promise<Uint8Array> {
  if(!stream)return new Uint8Array();const reader=stream.getReader();const chunks:Uint8Array[]=[];let size=0;
  try {while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>max){await reader.cancel();throw new AppError('RESPONSE_TOO_LARGE',413);}chunks.push(part.value);}}finally{reader.releaseLock();}
  return Buffer.concat(chunks,size);
}
export async function googleError(response:Response):Promise<never> {
  const reasons:string[]=[];
  try{
   const body=JSON.parse(Buffer.from(await readBounded(response.body,65536)).toString());
   if(Array.isArray(body.error?.errors))for(const error of body.error.errors)reasons.push(typeof error?.reason==='string'?error.reason:'unknown');
   if(Array.isArray(body.error?.details))for(const detail of body.error.details)if(detail?.['@type']==='type.googleapis.com/google.rpc.ErrorInfo')reasons.push(typeof detail.reason==='string'?detail.reason:'unknown');
  }catch{}
  const classification=(reason:string)=>{
   if(['quotaExceeded','dailyLimitExceeded','rateLimitExceeded','userRateLimitExceeded'].includes(reason))return 'GOOGLE_QUOTA_OR_RATE_LIMIT';
   if(['insufficientPermissions','ACCESS_TOKEN_SCOPE_INSUFFICIENT'].includes(reason))return 'GOOGLE_INSUFFICIENT_SCOPE';
   if(['accessNotConfigured','SERVICE_DISABLED'].includes(reason))return 'GOOGLE_API_CONFIGURATION_REQUIRED';
   return reason==='forbidden'?'GOOGLE_PERMISSION_DENIED':'GOOGLE_FORBIDDEN_UNKNOWN';
  };
  const categories=new Set(reasons.map(classification));
  const code=categories.size===1?[...categories][0]!:'GOOGLE_FORBIDDEN_UNKNOWN';
  if(response.status===429 || code==='GOOGLE_QUOTA_OR_RATE_LIMIT') throw new AppError('GOOGLE_QUOTA_OR_RATE_LIMIT',429);
  if(response.status===401)throw new AppError('GOOGLE_REAUTH_REQUIRED',409);
  if(response.status===403)throw new AppError(code,403);
  if(response.status===404)throw new AppError('GOOGLE_RESOURCE_NOT_FOUND',404);
  if(response.status>=500)throw new AppError('GOOGLE_TEMPORARILY_UNAVAILABLE',503);
  throw new AppError('GOOGLE_REQUEST_FAILED',400);
}
export async function jsonResponse(response:Response):Promise<Record<string,any>> {if(!response.ok)await googleError(response);return JSON.parse(Buffer.from(await readBounded(response.body,512*1024)).toString());}
export function googleUrl(value:string) {const u=new URL(value);if(u.protocol!=='https:'||u.hostname!=='www.googleapis.com'||u.username||u.password||u.port||u.hash||u.pathname!=='/upload/youtube/v3/videos')throw new AppError('INVALID_UPLOAD_SESSION');return u.href;}
