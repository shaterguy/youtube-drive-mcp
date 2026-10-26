export const VERSION = '0.1.0-dev1';
export const MCP_SCOPES = ['openid','offline_access','drive:read','youtube:read','youtube:write','uploads:write'] as const;
export const PROVIDER_SCOPES = {
  drive: ['openid','email','https://www.googleapis.com/auth/drive.readonly'],
  youtube: ['openid','email','https://www.googleapis.com/auth/youtube.upload','https://www.googleapis.com/auth/youtube.force-ssl'],
} as const;
export type Provider = keyof typeof PROVIDER_SCOPES;
export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) { super(code); this.code = code; this.status = status; }
}
export interface Config { origin: string; issuer: string; resource: string; databaseUrl: string; authSecret: string; encryptionKey: string; googleClientId: string; googleClientSecret: string; googleAgentClientId: string; googleAgentClientSecret: string; ownerEmail: string; youtubeChannelId: string }
export function loadConfig(env: Record<string,string|undefined>): Config {
  const get = (key: string) => {const value=env[key]; if(!value || value.trim()!==value) throw new AppError('CONFIGURATION_REQUIRED',503); return value;};
  const u = new URL(get('PUBLIC_ORIGIN'));
  if(u.protocol!=='https:' || u.pathname!=='/' || u.search || u.hash || u.username || u.password || u.port || !u.hostname.includes('.')) throw new AppError('INVALID_CONFIGURATION',503);
  const databaseUrl=get('DATABASE_URL'); const db=new URL(databaseUrl);
  if(!['postgres:','postgresql:'].includes(db.protocol) || !['require','verify-full'].includes(db.searchParams.get('sslmode')??'')) throw new AppError('INVALID_CONFIGURATION',503);
  const authSecret=get('BETTER_AUTH_SECRET'); const encryptionKey=get('TOKEN_ENCRYPTION_KEY');
  if(Buffer.byteLength(authSecret)<32 || !/^[A-Za-z0-9_-]{43}$/.test(encryptionKey) || Buffer.from(encryptionKey,'base64url').length!==32) throw new AppError('INVALID_CONFIGURATION',503);
  const ownerEmail=get('OWNER_EMAIL').toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) throw new AppError('INVALID_CONFIGURATION',503);
  const youtubeChannelId=get('YOUTUBE_CHANNEL_ID');if(!/^UC[A-Za-z0-9_-]{22}$/.test(youtubeChannelId)) throw new AppError('INVALID_CONFIGURATION',503);
  const googleClientId=get('GOOGLE_CLIENT_ID'),googleClientSecret=get('GOOGLE_CLIENT_SECRET');
  const googleAgentClientId=get('GOOGLE_AGENT_CLIENT_ID'),googleAgentClientSecret=get('GOOGLE_AGENT_CLIENT_SECRET');
  if(googleAgentClientId===googleClientId)throw new AppError('GOOGLE_OAUTH_CLIENTS_MUST_DIFFER',503);
  return {origin:u.origin,issuer:`${u.origin}/api/auth`,resource:`${u.origin}/mcp`,databaseUrl,authSecret,encryptionKey,googleClientId,googleClientSecret,googleAgentClientId,googleAgentClientSecret,ownerEmail,youtubeChannelId};
}
export function provider(value: unknown): Provider { if(value!=='drive' && value!=='youtube') throw new AppError('INVALID_PROVIDER'); return value; }
export function errorCode(error: unknown) { return error instanceof AppError ? error.code : 'SERVICE_UNAVAILABLE'; }
export function noStore(response: Response) { const headers=new Headers(response.headers);headers.set('Cache-Control','no-store');headers.set('Referrer-Policy','no-referrer');headers.set('X-Content-Type-Options','nosniff');return new Response(response.body,{status:response.status,statusText:response.statusText,headers}); }
