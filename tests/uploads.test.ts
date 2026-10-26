import {test} from 'node:test';
import assert from 'node:assert/strict';
import {resumeOffset,validateUploadMetadata,CHUNK_BYTES} from '../src/uploads.ts';

test('resumable Range means next byte; absent Range restarts at zero',()=>{
 assert.equal(resumeOffset(null,100),0);assert.equal(resumeOffset('bytes=0-31',100),32);
 assert.throws(()=>resumeOffset('bytes=2-31',100));assert.throws(()=>resumeOffset('bytes=0-100',100));
});
test('upload scheduling explicitly uses private and a future ISO publishAt',()=>{
 assert.equal(validateUploadMetadata({title:'영상',privacyStatus:'private'}).status.privacyStatus,'private');
 assert.throws(()=>validateUploadMetadata({title:'영상',privacyStatus:'public',publishAt:new Date(Date.now()+3600000).toISOString()}));
 assert.throws(()=>validateUploadMetadata({title:'영상',privacyStatus:'private',publishAt:'2020-01-01T00:00:00Z'}));
 assert.equal(CHUNK_BYTES,8*1024*1024);
});
