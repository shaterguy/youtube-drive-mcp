import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {AppError} from './config.ts';
export const random = () => randomBytes(32).toString('base64url');
export const digest = (value:string) => createHash('sha256').update(value).digest('base64url');
export class VaultCipher {
  readonly #key: Buffer;
  constructor(key: string) {this.#key=Buffer.from(key,'base64url');if(this.#key.length!==32) throw new AppError('INVALID_CONFIGURATION',503);}
  seal(value:string,context:string): string {const iv=randomBytes(12);const c=createCipheriv('aes-256-gcm',this.#key,iv);c.setAAD(Buffer.from(context));const bytes=Buffer.concat([c.update(value,'utf8'),c.final()]);return ['v1',iv.toString('base64url'),bytes.toString('base64url'),c.getAuthTag().toString('base64url')].join('.');}
  open(value:string,context:string): string {try {const [v,iv,data,tag,...rest]=value.split('.');if(v!=='v1'||!iv||!data||!tag||rest.length) throw new Error();const c=createDecipheriv('aes-256-gcm',this.#key,Buffer.from(iv,'base64url'));c.setAAD(Buffer.from(context));c.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([c.update(Buffer.from(data,'base64url')),c.final()]).toString('utf8');}catch {throw new AppError('CREDENTIAL_STORAGE_ERROR',503);}}
}
