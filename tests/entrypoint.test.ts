import {test} from 'node:test';
import assert from 'node:assert/strict';
import app from '../api/index.ts';
import {deployed} from '../src/runtime.ts';

test('Vercel selects the Web Standard fetch entrypoint and receives its Response',async()=>{
 // A bare default function selects Vercel's legacy (req,res) adapter, which ignores
 // returned Responses. Match the documented api/index.ts default {fetch} contract.
 assert.equal(typeof app,'object');
 const handler=app as typeof app & {fetch:typeof deployed};
 assert.equal(handler.fetch,deployed);
 const response=await handler.fetch(new Request('https://youtube-drive-mcp.vercel.app/privacy'));
 assert.ok(response instanceof Response);
 // This secret-free process has no deployment configuration. Its structured error
 // must still return through the adapter rather than leave the HTTP socket open.
 assert.equal(response.status,503);
 assert.deepEqual(await response.json(),{error:'CONFIGURATION_REQUIRED'});
});
