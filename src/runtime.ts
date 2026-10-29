import {Pool} from 'pg';
import {requireMcpAuth} from '@better-auth/mcp';
import {createAuth,ownerFromClaims} from './auth.ts';
import {AppError,MCP_SCOPES,VERSION,errorCode,loadConfig,noStore,type Config} from './config.ts';
import {assertBoundary,bounded} from './http.ts';
import {Providers} from './providers.ts';
import {Service} from './service.ts';
import {handleMcp} from './mcp.ts';
import {createUi} from './ui.ts';
import {createAuthHandler} from './auth-handler.ts';
const AUTH_ROUTES:Record<string,readonly string[]>={
 '/api/auth/callback/google':['GET'], '/api/auth/jwks':['GET','HEAD'],
 '/api/auth/oauth2/authorize':['GET'], '/api/auth/oauth2/token':['POST'], '/api/auth/oauth2/revoke':['POST'], '/api/auth/oauth2/introspect':['POST'], '/api/auth/oauth2/userinfo':['GET','POST'],
 '/.well-known/oauth-authorization-server/api/auth':['GET','HEAD'], '/api/auth/.well-known/oauth-authorization-server':['GET','HEAD'], '/api/auth/.well-known/openid-configuration':['GET','HEAD'], '/.well-known/openid-configuration/api/auth':['GET','HEAD'], '/.well-known/oauth-protected-resource':['GET','HEAD'], '/.well-known/oauth-protected-resource/mcp':['GET','HEAD']
};
export function createRuntime(config:Config,pool:Pool){const auth=createAuth(config,pool);const authHandler=createAuthHandler(pool,request=>auth.handler(request));const providers=new Providers(pool,config);const ui=createUi(auth,config,providers);const mcp=requireMcpAuth(auth,async(request,claims)=>{const owner=await ownerFromClaims(pool,config,claims);return handleMcp(request,new Service(providers,owner.id),owner.scopes);},{issuer:config.issuer,resource:config.resource,jwksUrl:`${config.issuer}/jwks`,challengeScopes:MCP_SCOPES});
 return {auth,providers,fetch:async(request:Request):Promise<Response>=>{try{assertBoundary(request,config);const path=new URL(request.url).pathname;
  if(path==='/health'&&request.method==='GET'){await pool.query('SELECT 1');return noStore(Response.json({service:'youtube-drive-mcp',version:VERSION,status:'alive',database:'ready',mcp:config.resource}));}
  if(path==='/mcp'){if(request.method!=='POST')return noStore(new Response(null,{status:405,headers:{Allow:'POST'}}));return noStore(await mcp(await bounded(request)));}
  const methods=AUTH_ROUTES[path];if(methods){if(!methods.includes(request.method))return noStore(new Response(null,{status:405,headers:{Allow:methods.join(', ')}}));return noStore(await authHandler(await bounded(request)));}
  if(['/', '/sign-in','/privacy','/terms','/connect','/consent','/google/callback'].includes(path)||path.startsWith('/ui/'))return noStore(await ui(request));
  throw new AppError('NOT_FOUND',404);
 }catch(error){return noStore(Response.json({error:errorCode(error)},{status:error instanceof AppError?error.status:503}));}}};
}
let runtime:ReturnType<typeof createRuntime>|undefined;
export async function deployed(request:Request){try{if(!runtime){const config=loadConfig(process.env);const pool=new Pool({connectionString:config.databaseUrl,max:8,connectionTimeoutMillis:10000,idleTimeoutMillis:30000,application_name:'youtube-drive-mcp'});pool.on('error',()=>{});runtime=createRuntime(config,pool);}return await runtime.fetch(request);}catch(error){return noStore(Response.json({error:errorCode(error)},{status:503}));}}
