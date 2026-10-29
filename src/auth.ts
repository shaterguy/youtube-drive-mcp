import {betterAuth} from 'better-auth';
import type {BetterAuthOptions} from 'better-auth/types';
import {genericOAuth,jwt} from 'better-auth/plugins';
import {mcp} from '@better-auth/mcp';
import {cimd} from '@better-auth/cimd';
import {fetchClientMetadataResource} from '@better-auth/cimd/node';
import type {Pool} from 'pg';
import {AppError,MCP_SCOPES,type Config} from './config.ts';
import {GRANT_CLAIM,issueGrant,storedStrings} from './grants.ts';

export function verifiedOwnerSubject(profile:Record<string,unknown>,ownerEmail:string):string {
 if(profile.email_verified!==true || typeof profile.email!=='string' || profile.email.toLowerCase()!==ownerEmail || typeof profile.sub!=='string' || !profile.sub)throw new AppError('OWNER_ACCOUNT_REQUIRED',403);return profile.sub;
}
export function authOptions(config:Config,pool:Pool,database:NonNullable<BetterAuthOptions['database']>=pool){
 return {
  appName:'YouTube Drive MCP',baseURL:config.origin,basePath:'/api/auth',secret:config.authSecret,database,
  trustedOrigins:[config.origin],emailAndPassword:{enabled:false},logger:{disabled:true},onAPIError:{throw:true},
  disabledPaths:['/token','/get-access-token','/refresh-token','/link-social','/unlink-account'],
  account:{encryptOAuthTokens:true,updateAccountOnSignIn:true,storeStateStrategy:'database',storeAccountCookie:false,skipStateCookieCheck:false,accountLinking:{enabled:false,disableImplicitLinking:true,allowDifferentEmails:false}},
  databaseHooks:{account:{create:{before:async()=>({data:{idToken:null}})},update:{before:async()=>({data:{idToken:null}})}}},
  session:{expiresIn:30*86400,updateAge:86400,cookieCache:{enabled:false}},
  plugins:[
   genericOAuth({config:[{providerId:'google',clientId:config.googleClientId,clientSecret:config.googleClientSecret,discoveryUrl:'https://accounts.google.com/.well-known/openid-configuration',requireIdTokenVerification:true,accountSubject:({profile})=>verifiedOwnerSubject(profile,config.ownerEmail),disableProviderLogout:true,disableIdTokenNonceBinding:false,pkce:true,prompt:'select_account',redirectURI:`${config.origin}/api/auth/callback/google`,scopes:['openid','email','profile'],authorizationUrlParams:{login_hint:config.ownerEmail},tokenEndpointAuth:{method:'client_secret_post'}}]}),
   jwt({disableSettingJwtHeader:true,jwt:{issuer:config.issuer}}),
   mcp({loginPage:'/sign-in',consentPage:'/consent',resource:config.resource,resources:[{identifier:config.resource,allowedScopes:[...MCP_SCOPES]}],scopes:[...MCP_SCOPES],grantTypes:['authorization_code','refresh_token'],allowDynamicClientRegistration:false,allowUnauthenticatedClientRegistration:false,clientRegistrationRequirePKCE:true,storeTokens:'hashed',refreshTokenReuseInterval:30,accessTokenExpiresIn:300,refreshTokenExpiresIn:365*86400,codeExpiresIn:120,
    postLogin:{page:'/connect',consentReferenceId:({user})=>user.id,shouldRedirect:()=>false},
    extensions:[{claims:{accessToken:async input=>{
     if(!input.user||!input.resources?.includes(config.resource))throw new AppError('AUTH_REQUIRED',401);
     const user=(await pool.query('SELECT email,"emailVerified" FROM "user" WHERE id=$1',[input.user.id])).rows[0];
     if(!user||user.email.toLowerCase()!==config.ownerEmail||user.emailVerified!==true)throw new AppError('AUTH_REQUIRED',401);
     const grant=await issueGrant(pool,{ownerId:input.user.id,clientId:input.client.clientId,referenceId:input.referenceId,grantType:input.grantType,resource:config.resource,scopes:input.scopes});
     return {'urn:youtube-drive-mcp:owner':input.user.id,[GRANT_CLAIM]:grant};
    }}}]
   }),
   cimd({fetchClientMetadataResource,metadataProfile:'mcp-2026-07-28'}),
  ],
 } satisfies BetterAuthOptions;
}
export function createAuth(config:Config,pool:Pool){return betterAuth(authOptions(config,pool));}
export type Auth=ReturnType<typeof createAuth>;
export async function ownerSession(auth:Auth,config:Config,request:Request){const session=await auth.api.getSession({headers:request.headers});if(!session||session.user.email.toLowerCase()!==config.ownerEmail||!session.user.emailVerified)throw new AppError('AUTH_REQUIRED',401);return session;}
export async function ownerFromClaims(pool:Pool,config:Config,claims:Record<string,unknown>):Promise<{id:string;scopes:Set<string>}>{
 const id=claims['urn:youtube-drive-mcp:owner'];const client=claims.client_id;
 const aud=typeof claims.aud==='string'?[claims.aud]:claims.aud;
 if(typeof id!=='string'||id!==claims.sub||typeof client!=='string'||claims.azp!==client||!Array.isArray(aud)||!aud.includes(config.resource)||typeof claims.exp!=='number'||claims.exp*1000<=Date.now())throw new AppError('AUTH_REQUIRED',401);
 const scopes=new Set(typeof claims.scope==='string'?claims.scope.split(' '):[]);
 const r=await pool.query(`SELECT u.email,u."emailVerified",c.scopes,c.resources,g.grant_id,g.legacy_allowed FROM "user" u JOIN "oauthConsent" c ON c."userId"=u.id JOIN "oauthClient" p ON p."clientId"=c."clientId" JOIN mcp_grants g ON g.owner_id=u.id AND g.client_id=p."clientId" WHERE u.id=$1 AND c."clientId"=$2 AND c."referenceId"=$1 AND p.disabled IS NOT TRUE AND g.revoked_at IS NULL`,[id,client]);
 const row=r.rows[0];if(r.rows.length!==1||row.email.toLowerCase()!==config.ownerEmail||row.emailVerified!==true||!storedStrings(row.resources).includes(config.resource)||![...scopes].every(s=>storedStrings(row.scopes).includes(s))||!(typeof claims[GRANT_CLAIM]==='string'?claims[GRANT_CLAIM]===row.grant_id:claims[GRANT_CLAIM]===undefined&&row.legacy_allowed===true))throw new AppError('AUTH_REQUIRED',401);
 return {id,scopes};
}
