import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type {Pool} from 'pg';
import {AppError} from '../src/config.ts';
import {Providers} from '../src/providers.ts';
import type {Service} from '../src/service.ts';
import {advanceBatch} from '../src/mcp.ts';
import {config} from './fixtures.ts';

test('upload PUT accepts 308 Location without following redirects or sending credentials to another endpoint',async()=>{
 let otherRequests=0;
 const other=http.createServer((_req,res)=>{otherRequests++;res.end('unexpected');});
 await new Promise<void>(resolve=>other.listen(0,'127.0.0.1',resolve));
 const otherPort=(other.address() as import('node:net').AddressInfo).port;
 const server=http.createServer((_req,res)=>{res.writeHead(308,{Range:'bytes=0-7',Location:`http://127.0.0.1:${otherPort}/forbidden`});res.end();});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=(server.address() as import('node:net').AddressInfo).port;
 const providers=new Providers({} as Pool,config,(_url,init)=>fetch(`http://127.0.0.1:${port}/upload`,init));
 providers.token=async()=> 'test-only-token';
 try{
  const response=await providers.request('owner','youtube','https://www.googleapis.com/upload/youtube/v3/videos?upload_id=test',{method:'PUT'});
  assert.equal(response.status,308);assert.equal(response.headers.get('range'),'bytes=0-7');await response.body?.cancel();
  assert.equal(otherRequests,0);
  await assert.rejects(providers.request('owner','youtube','https://www.googleapis.com/youtube/v3/channels'),/fetch failed/);
  await assert.rejects(providers.request('owner','youtube','https://untrusted.example/upload/youtube/v3/videos',{method:'PUT'}),{code:'INVALID_GOOGLE_ENDPOINT'});
  assert.equal(otherRequests,0);
 }finally{server.closeAllConnections();other.closeAllConnections();await Promise.all([new Promise<void>(r=>server.close(()=>r())),new Promise<void>(r=>other.close(()=>r()))]);}
});

const jobId='00000000-0000-4000-8000-000000000001';
const snapshot={jobId,status:'uploading',driveFileId:'file',channelId:config.youtubeChannelId,uploadedBytes:8,totalBytes:16,percent:50,videoId:null,videoUrl:null,lastError:null};
function serviceWithFailure(code:string,status='uploading'){
 let reads=0;
 return {ownerId:'owner',uploads:{status:async()=>{reads++;return {...snapshot,status:reads>1?status:'uploading',uploadedBytes:reads>1?12:8,lastError:reads>1?code:null};},advance:async()=>{throw new AppError(code,503);}}} as unknown as Service;
}
test('transient upload errors retain the latest job progress and same-job continuation',async()=>{
 const result=await advanceBatch(serviceWithFailure('UPLOAD_RETRY_SAME_JOB'),jobId);
 assert.equal(result.jobId,jobId);assert.equal(result.uploadedBytes,12);assert.equal(result.error,'UPLOAD_RETRY_SAME_JOB');assert.equal(result.retrySameJob,true);assert.deepEqual(result.continuation,{tool:'upload_advance',arguments:{jobId}});
});
test('source/session/initialization and authorization failures retain the job without automatic continuation',async()=>{
 for(const [code,status] of [['UPLOAD_SOURCE_CHANGED','source_changed'],['UPLOAD_SESSION_EXPIRED','session_expired'],['UPLOAD_INITIALIZATION_UNCERTAIN','initialization_uncertain'],['GOOGLE_REAUTH_REQUIRED','uploading']]){
  const result=await advanceBatch(serviceWithFailure(code!,status),jobId);
  assert.equal(result.jobId,jobId);assert.equal(result.status,status);assert.equal(result.error,code);assert.equal(result.retrySameJob,false);assert.equal(result.continuation,null);
 }
});
test('failure of progress readback still exposes the supplied job ID without unsafe continuation',async()=>{
 const service={ownerId:'owner',uploads:{status:async()=>{throw new AppError('SERVICE_UNAVAILABLE',503);}}} as unknown as Service;
 const result=await advanceBatch(service,jobId);assert.equal(result.jobId,jobId);assert.equal(result.error,'SERVICE_UNAVAILABLE');assert.equal(result.retrySameJob,false);assert.equal(result.continuation,null);
});

test('a committed completion discovered after an error is returned as success without another continuation',async()=>{
 const result=await advanceBatch(serviceWithFailure('UPLOAD_RETRY_SAME_JOB','complete'),jobId);
 assert.equal(result.status,'complete');assert.equal(result.error,undefined);assert.equal(result.retrySameJob,false);assert.equal(result.continuation,null);
});
test('an already stopped job is returned without calling advance',async()=>{
 let calls=0;
 const service={ownerId:'owner',uploads:{status:async()=>({...snapshot,status:'session_expired'}),advance:async()=>{calls++;throw new Error('must not advance');}}} as unknown as Service;
 const result=await advanceBatch(service,jobId);assert.equal(calls,0);assert.equal(result.status,'session_expired');assert.equal(result.retrySameJob,false);assert.equal(result.continuation,null);
});
