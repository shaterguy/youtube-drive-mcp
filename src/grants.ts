import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {AppError} from './config.ts';

export const GRANT_CLAIM='urn:youtube-drive-mcp:grant';
export function storedStrings(value:unknown):string[]{
 if(typeof value==='string')try{value=JSON.parse(value);}catch{}
 return Array.isArray(value)&&value.every(s=>typeof s==='string')?value:[];
}
/** Called only after the maintained provider validates the code or refresh token. */
export async function issueGrant(pool:Pool,input:{ownerId:string;clientId:string;referenceId:string|undefined;grantType:string|undefined;resource:string;scopes:readonly string[]}):Promise<string>{
 if(input.referenceId!==input.ownerId||!['authorization_code','refresh_token'].includes(input.grantType??''))throw new AppError('AUTH_REQUIRED',401);
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  const result=await db.query(`SELECT c.scopes,c.resources FROM "oauthConsent" c JOIN "oauthClient" p ON p."clientId"=c."clientId"
   WHERE c."userId"=$1 AND c."clientId"=$2 AND c."referenceId"=$1 AND p.disabled IS NOT TRUE FOR SHARE OF c,p`,[input.ownerId,input.clientId]);
  const consent=result.rows[0];
  if(result.rows.length!==1||!storedStrings(consent.resources).includes(input.resource)||!input.scopes.every(s=>storedStrings(consent.scopes).includes(s)))throw new AppError('AUTH_REQUIRED',401);
  if(input.grantType==='authorization_code'){
   // A fresh explicit authorization replaces this client's old family. Otherwise
   // an old refresh could acquire the new generation after reconnecting.
   await db.query('DELETE FROM "oauthRefreshToken" WHERE "userId"=$1 AND "clientId"=$2',[input.ownerId,input.clientId]);
   const next=await db.query(`INSERT INTO mcp_grants(owner_id,client_id,grant_id,legacy_allowed) VALUES($1,$2,$3,false)
    ON CONFLICT(owner_id,client_id) DO UPDATE SET grant_id=EXCLUDED.grant_id,revoked_at=NULL,legacy_allowed=false RETURNING grant_id`,[input.ownerId,input.clientId,randomUUID()]);
   await db.query('COMMIT');return next.rows[0].grant_id;
  }
  const resultGrant=await db.query('SELECT grant_id FROM mcp_grants WHERE owner_id=$1 AND client_id=$2 AND revoked_at IS NULL FOR SHARE',[input.ownerId,input.clientId]);
  if(resultGrant.rows.length!==1)throw new AppError('AUTH_REQUIRED',401);
  await db.query('COMMIT');return resultGrant.rows[0].grant_id;
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
