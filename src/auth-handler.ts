import type {Pool} from 'pg';
import {AppError} from './config.ts';

const WAIT_MS=5000,MAX_QUEUED=31;
type Waiter={resolve:()=>void;timer:ReturnType<typeof setTimeout>};
/** Single-owner service: order token issuance and revocation across instances.
 * The maintained provider still owns client authentication and encrypted replay.
 */
export function createAuthHandler(pool:Pick<Pool,'connect'>,handle:(request:Request)=>Promise<Response>){
 let active=false;const queue:Waiter[]=[];
 const enter=async()=>{
  if(!active){active=true;return;}
  if(queue.length>=MAX_QUEUED)throw new AppError('AUTH_TEMPORARILY_UNAVAILABLE',503);
  await new Promise<void>((resolve,reject)=>{
   const waiter:Waiter={resolve,timer:setTimeout(()=>{const index=queue.indexOf(waiter);if(index>=0)queue.splice(index,1);reject(new AppError('AUTH_TEMPORARILY_UNAVAILABLE',503));},WAIT_MS)};
   queue.push(waiter);
  });
 };
 const leave=()=>{const next=queue.shift();if(next){clearTimeout(next.timer);next.resolve();}else active=false;};
 return async(request:Request):Promise<Response>=>{
  if(request.method!=='POST'||!['/api/auth/oauth2/token','/api/auth/oauth2/revoke'].includes(new URL(request.url).pathname))return handle(request);
  const deadline=performance.now()+WAIT_MS;await enter();
  try{
   if(performance.now()>=deadline)throw new AppError('AUTH_TEMPORARILY_UNAVAILABLE',503);
   const client=await pool.connect();let failed=false;const lost=()=>{failed=true;};client.on('error',lost);
   try{
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query('SET LOCAL idle_in_transaction_session_timeout=0');
    // Fixed service namespace; no raw token, client secret or request body enters SQL.
    await client.query('SELECT pg_advisory_xact_lock(89177232)');
    if(failed||performance.now()>=deadline)throw new AppError('AUTH_TEMPORARILY_UNAVAILABLE',503);
    const response=await handle(request);
    if(failed)throw new AppError('AUTH_TEMPORARILY_UNAVAILABLE',503);
    await client.query('COMMIT');return response;
   }catch(error){try{await client.query('ROLLBACK');}catch{failed=true;}throw error;
   }finally{client.removeListener('error',lost);client.release(failed);}
  }finally{leave();}
 };
}
