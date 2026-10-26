import {AppError} from './config.ts';
import {Providers} from './providers.ts';
import {jsonResponse,readBounded} from './http.ts';
import {Uploads} from './uploads.ts';
import {Analytics} from './analytics.ts';
const fileId=(value:string)=>{if(!/^[A-Za-z0-9_-]{1,256}$/.test(value))throw new AppError('INVALID_DRIVE_FILE_ID');return value;};
const youtubeId=(value:string)=>{if(!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw new AppError('INVALID_YOUTUBE_ID');return value;};
export class Service {
 readonly providers:Providers;readonly uploads:Uploads;readonly analytics:Analytics;readonly ownerId:string;
 constructor(providers:Providers,ownerId:string){this.providers=providers;this.analytics=new Analytics(providers,ownerId);this.uploads=new Uploads(providers.pool,providers);this.ownerId=ownerId;}
 async status(){return {ownerEmail:this.providers.config.ownerEmail,connections:await this.providers.list(this.ownerId),analytics:await this.analytics.status(),manageUrl:`${this.providers.config.origin}/connect`};}
 async driveList(input:{query?:string;pageToken?:string;pageSize?:number}){const u=new URL('https://www.googleapis.com/drive/v3/files');u.search=new URLSearchParams({q:input.query?`trashed = false and (${input.query})`:'trashed = false',pageSize:String(input.pageSize??30),fields:'nextPageToken,files(id,name,mimeType,size,modifiedTime,webViewLink,version)',orderBy:'modifiedTime desc',supportsAllDrives:'true',includeItemsFromAllDrives:'true',...(input.pageToken?{pageToken:input.pageToken}:{})}).toString();return jsonResponse(await this.providers.request(this.ownerId,'drive',u.href));}
 async driveMetadata(id:string){return jsonResponse(await this.providers.request(this.ownerId,'drive',`https://www.googleapis.com/drive/v3/files/${fileId(id)}?fields=id,name,mimeType,size,modifiedTime,version,md5Checksum,headRevisionId,webViewLink,capabilities(canDownload)&supportsAllDrives=true`));}
 async driveText(id:string){const meta=await this.driveMetadata(id);let url=`https://www.googleapis.com/drive/v3/files/${fileId(id)}?alt=media`;if(meta.mimeType==='application/vnd.google-apps.document')url=`https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text%2Fplain`;else if(meta.mimeType==='application/vnd.google-apps.spreadsheet')url=`https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text%2Fcsv`;else if(!meta.mimeType?.startsWith('text/')&&!['application/json','application/xml'].includes(meta.mimeType))throw new AppError('TEXT_FILE_REQUIRED');const response=await this.providers.request(this.ownerId,'drive',url);if(!response.ok)await jsonResponse(response);const text=Buffer.from(await readBounded(response.body,1024*1024)).toString('utf8');return {id,name:meta.name,mimeType:meta.mimeType,text};}
 async channel(){await this.providers.requireChannel(this.ownerId);return jsonResponse(await this.providers.request(this.ownerId,'youtube','https://www.googleapis.com/youtube/v3/channels?part=id,snippet,contentDetails,statistics&mine=true'));}
 async videos(input:{pageToken?:string;pageSize?:number}){const channel=await this.providers.requireChannel(this.ownerId);if(!channel.channel_uploads)throw new AppError('YOUTUBE_UPLOADS_PLAYLIST_MISSING');const u=new URL('https://www.googleapis.com/youtube/v3/playlistItems');u.search=new URLSearchParams({part:'snippet,contentDetails,status',playlistId:channel.channel_uploads,maxResults:String(input.pageSize??30),...(input.pageToken?{pageToken:input.pageToken}:{})}).toString();return jsonResponse(await this.providers.request(this.ownerId,'youtube',u.href));}
 async playlists(input:{pageToken?:string;pageSize?:number}){const channel=await this.providers.requireChannel(this.ownerId);const u=new URL('https://www.googleapis.com/youtube/v3/playlists');u.search=new URLSearchParams({part:'snippet,status,contentDetails',channelId:channel.channel_id!,maxResults:String(input.pageSize??30),...(input.pageToken?{pageToken:input.pageToken}:{})}).toString();return jsonResponse(await this.providers.request(this.ownerId,'youtube',u.href));}
 async video(id:string){const channel=await this.providers.requireChannel(this.ownerId);const body=await jsonResponse(await this.providers.request(this.ownerId,'youtube',`https://www.googleapis.com/youtube/v3/videos?part=snippet,status,statistics,processingDetails&id=${youtubeId(id)}`));const video=body.items?.[0];if(!video)throw new AppError('YOUTUBE_VIDEO_NOT_FOUND',404);if(video.snippet?.channelId!==channel.channel_id)throw new AppError('YOUTUBE_VIDEO_CHANNEL_MISMATCH',403);return video;}
 async updateVideo(input:{videoId:string;title?:string;description?:string;tags?:string[];privacyStatus?:'private'|'unlisted'|'public';publishAt?:string|null;madeForKids?:boolean;containsSyntheticMedia?:boolean}){
  const old=await this.video(input.videoId);
  const snippetChanged=input.title!==undefined||input.description!==undefined||input.tags!==undefined;
  const statusChanged=input.privacyStatus!==undefined||input.publishAt!==undefined||input.madeForKids!==undefined||input.containsSyntheticMedia!==undefined;
  if(!snippetChanged&&!statusChanged)return old;
  const parts:string[]=[];const body:Record<string,unknown>={id:input.videoId};
  if(snippetChanged){
   parts.push('snippet');const snippet:Record<string,unknown>={};
   for(const key of ['title','description','categoryId','tags','defaultLanguage','defaultAudioLanguage'])if(old.snippet[key]!==undefined)snippet[key]=old.snippet[key];
   if(input.title!==undefined)snippet.title=input.title;if(input.description!==undefined)snippet.description=input.description;if(input.tags!==undefined)snippet.tags=input.tags;
   body.snippet=snippet;
  }
  if(statusChanged){
   parts.push('status');const status:Record<string,any>={};
   for(const key of ['privacyStatus','publishAt','selfDeclaredMadeForKids','containsSyntheticMedia','embeddable','license','publicStatsViewable'])if(old.status[key]!==undefined)status[key]=old.status[key];
   if(input.privacyStatus!==undefined)status.privacyStatus=input.privacyStatus;
   if(input.madeForKids!==undefined)status.selfDeclaredMadeForKids=input.madeForKids;
   if(input.containsSyntheticMedia!==undefined)status.containsSyntheticMedia=input.containsSyntheticMedia;
   if(input.publishAt===null||status.privacyStatus!=='private')delete status.publishAt;
   if(input.publishAt){if(status.privacyStatus!=='private'||!Number.isFinite(Date.parse(input.publishAt))||Date.parse(input.publishAt)<=Date.now())throw new AppError('INVALID_PUBLISH_TIME');status.publishAt=input.publishAt;}
   body.status=status;
  }
  return jsonResponse(await this.providers.request(this.ownerId,'youtube','https://www.googleapis.com/youtube/v3/videos?part='+parts.join(','),{method:'PUT',headers:{'Content-Type':'application/json','If-Match':old.etag},body:JSON.stringify(body)}));
 }
 async thumbnail(input:{videoId:string;driveFileId:string}){await this.video(input.videoId);const meta=await this.driveMetadata(input.driveFileId);if(!['image/jpeg','image/png'].includes(meta.mimeType)||Number(meta.size)>2*1024*1024||Number(meta.size)<=0)throw new AppError('THUMBNAIL_IMAGE_REQUIRED');const image=await this.providers.request(this.ownerId,'drive',`https://www.googleapis.com/drive/v3/files/${fileId(input.driveFileId)}?alt=media`);if(!image.ok)await jsonResponse(image);const bytes=await readBounded(image.body,2*1024*1024);return jsonResponse(await this.providers.request(this.ownerId,'youtube',`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${youtubeId(input.videoId)}&uploadType=media`,{method:'POST',headers:{'Content-Type':meta.mimeType},body:new Uint8Array(bytes).buffer}));}
 async addPlaylist(input:{playlistId:string;videoId:string}){const channel=await this.providers.requireChannel(this.ownerId);await this.video(input.videoId);const body=await jsonResponse(await this.providers.request(this.ownerId,'youtube',`https://www.googleapis.com/youtube/v3/playlists?part=snippet&id=${youtubeId(input.playlistId)}`));if(body.items?.[0]?.snippet?.channelId!==channel.channel_id)throw new AppError('YOUTUBE_PLAYLIST_CHANNEL_MISMATCH',403);const existing=await jsonResponse(await this.providers.request(this.ownerId,'youtube',`https://www.googleapis.com/youtube/v3/playlistItems?part=id&playlistId=${input.playlistId}&videoId=${input.videoId}`));if(existing.items?.length)return {alreadyPresent:true,id:existing.items[0].id};return jsonResponse(await this.providers.request(this.ownerId,'youtube','https://www.googleapis.com/youtube/v3/playlistItems?part=snippet',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({snippet:{playlistId:input.playlistId,resourceId:{kind:'youtube#video',videoId:input.videoId}}})}));}
}
