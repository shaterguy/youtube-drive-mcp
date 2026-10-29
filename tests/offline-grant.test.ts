import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mcpAuthFixture} from './mcp-auth-fixture.ts';
test('real MCP OAuth refresh and signed app authority survive expired and deleted web sessions',async t=>{
 t.mock.method(globalThis,'fetch',async()=>{throw new Error('UNEXPECTED_FIXTURE_NETWORK');});
 const f=await mcpAuthFixture();
 try{
  await f.query('UPDATE "session" SET "expiresAt"=now()-interval \'1 day\' WHERE id=$1',[f.sessionId]);
  const first=await f.rotate();assert.equal((await f.owner(first.access_token)).id,f.userId);
  await f.context.internalAdapter.deleteSession('synthetic-browser-cookie');
  assert.equal((await f.query('SELECT count(*)::int AS n FROM "session" WHERE id=$1',[f.sessionId])).rows[0]!.n,0);
  assert.equal((await f.query('SELECT "sessionId" FROM "oauthRefreshToken" WHERE revoked IS NULL')).rows[0]!.sessionId,null);
  const second=await f.rotate(first.refresh_token);assert.equal((await f.owner(second.access_token)).id,f.userId);
 }finally{await f.close();}
});
