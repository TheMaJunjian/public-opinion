import { randomBytes, scrypt, timingSafeEqual, createHash, createPublicKey, verify } from 'node:crypto';
import { promisify } from 'node:util';
import { compare as compareBcrypt } from 'bcryptjs';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { PARTICIPATION_AGREEMENT_VERSION, type Session } from '@gonglun/core';
import { DomainError, id, integer, Mutation, Store } from './db.js';
import { distribution } from './economy.js';
import { assertActiveAccount } from './account-access.js';

const credentials=z.object({name:z.string().trim().min(2).max(40).regex(/^[\p{L}\p{N}_ .-]+$/u),password:z.string().min(1)}).strict();
const derivePassword=promisify(scrypt);
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const token=()=>randomBytes(32).toString('hex');
const signingFields={publicKey:z.string().max(4000).nullable().optional(),deviceId:z.string().min(1).max(100).optional()};
const agreementFields={acceptedAgreementVersion:z.string().max(80).optional()};
function requireAgreement(version: string | undefined) {
  if(version !== PARTICIPATION_AGREEMENT_VERSION)
    throw new DomainError('请阅读并确认当前版本的《公论参与协议》',428,'AGREEMENT_REQUIRED');
}
async function recordAgreement(store:Store,userId:string) {
  await store.db.prepare('INSERT INTO participation_acceptances("userId",version) VALUES($1,$2) ON CONFLICT DO NOTHING').run(userId,PARTICIPATION_AGREEMENT_VERSION);
}
function normalizeCredentials(input:unknown) {
  if(!input||typeof input!=='object')return input;
  const {username,...rest}=input as Record<string,unknown>;
  return {...rest,name:rest.name??username};
}
async function bindKey(store:Store,userId:string,deviceId:string|undefined,publicKey:string|null|undefined) {
  if(!publicKey)return;
  if(!deviceId)throw new DomainError('绑定签名密钥需要设备编号');
  try {const key=JSON.parse(publicKey);if(key.d||!((key.kty==='OKP'&&key.crv==='Ed25519')||(key.kty==='EC'&&key.crv==='P-256')))throw new Error();createPublicKey({key,format:'jwk'});}catch {throw new DomainError('签名公钥无效');}
  await store.db.prepare('INSERT INTO signing_keys VALUES ($1,$2,$3,$4) ON CONFLICT("userId","deviceId") DO UPDATE SET "publicKey"=excluded."publicKey","createdAt"=excluded."createdAt"').run(userId,deviceId,publicKey,new Date().toISOString());
}
async function currentSessionRow(store:Store,req:Request) {
  const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('gonglun_session='))?.slice(16);
  if(!cookie) return null;
  const row=await store.db.prepare(`SELECT token,"userId",csrf,expires,"deviceId" FROM sessions s WHERE token=$1
    AND s."agreementVersion"=$2
    AND NOT EXISTS(SELECT 1 FROM disabled_accounts d WHERE d."userId"=s."userId")`).get(hash(cookie),PARTICIPATION_AGREEMENT_VERSION) as {token:string;userId:string;csrf:string;expires:number;deviceId?:string}|undefined;
  if(!row||row.expires<=Date.now()) return null;
  return row;
}
/** Visibility checks need identity, without loading account balances or signing keys. */
export async function currentSessionUserId(store:Store,req:Request):Promise<string|undefined> {
  return (await currentSessionRow(store,req))?.userId;
}
export async function currentSession(store:Store,req:Request):Promise<Session|null> {
  const row=await currentSessionRow(store,req);
  if(!row)return null;
  const key=row.deviceId?await store.db.prepare('SELECT "publicKey" FROM signing_keys WHERE "userId"=$1 AND "deviceId"=$2').get(row.userId,row.deviceId):undefined;
  return {user:{...await store.user(row.userId),...(key?{publicKey:String(key.publicKey)}:{})},account:await store.account(row.userId),rules:await store.rules(),csrf:row.csrf};
}
export async function requireSession(store:Store,req:Request):Promise<Session> {
  const session=await currentSession(store,req); if(!session) throw new DomainError('请先登录',401,'SESSION_REQUIRED'); return session;
}
export async function requireCsrf(store:Store,req:Request):Promise<Session> {
  const session=await requireSession(store,req);
  if(req.get('x-csrf-token')!==session.csrf) throw new DomainError('会话校验失败，请刷新后重试',403);
  return session;
}
export async function verifyDeviceSignature(store:Store,req:Request,session:Session):Promise<{deviceId:string;publicKey:string;payload:string;signature:string}|undefined> {
  if(!session.user.publicKey)return;
  const deviceId=req.get('x-device-id'),signature=req.get('x-signature');
  if(!deviceId||!signature)throw new DomainError('当前设备已绑定签名密钥，请重新登录以恢复签名',401);
  const row=await store.db.prepare('SELECT "publicKey" FROM signing_keys WHERE "userId"=$1 AND "deviceId"=$2').get(session.user.id,deviceId);
  if(!row||row.publicKey!==session.user.publicKey)throw new DomainError('设备签名密钥不匹配',401);
  const encoded=req.get('x-signed-payload');
  let payload=encoded?Buffer.from(encoded,'base64').toString('utf8'):JSON.stringify(req.body??{});
  try {
    const signed=JSON.parse(payload);
    if(!encoded||signed.method!==req.method||signed.path!==req.originalUrl.split('?')[0]||signed.requestId!==req.get('x-request-id')||signed.bodyHash!==hash(JSON.stringify(req.body??{})))throw new Error();
    const key=JSON.parse(session.user.publicKey);
    const valid=verify(key.kty==='EC'?'sha256':null,Buffer.from(payload),{key:createPublicKey({key,format:'jwk'}),dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64'));
    if(!valid)throw new Error();
  }catch {throw new DomainError('设备签名无效或与发送内容不一致',401);}
  return {deviceId,publicKey:session.user.publicKey,payload,signature};
}
export function checkOrigin(req:Request) {
  const origin=req.get('origin');
  if(origin){let host:string;try{host=new URL(origin).host;}catch{throw new DomainError('不允许跨站写入',403);}if(host!==req.get('host'))throw new DomainError('不允许跨站写入',403);}
}
async function createSession(store:Store,userId:string,deviceId?:string):Promise<{raw:string;session:Session}> {
  await assertActiveAccount(store,userId,true);
  const raw=token(), csrf=token();
  await store.db.prepare('DELETE FROM sessions WHERE expires<$1').run(Date.now());
  const at=Date.now();
  await store.db.prepare('INSERT INTO sessions(token,"userId",csrf,expires,"deviceId","agreementVersion") VALUES ($1,$2,$3,$4,$5,$6)').run(hash(raw),userId,csrf,at+30*86400000,deviceId??null,PARTICIPATION_AGREEMENT_VERSION);
  const key=deviceId?await store.db.prepare('SELECT "publicKey" FROM signing_keys WHERE "userId"=$1 AND "deviceId"=$2').get(userId,deviceId):undefined;
  return {raw,session:{user:{...await store.user(userId),...(key?{publicKey:String(key.publicKey)}:{})},account:await store.account(userId),rules:await store.rules(),csrf}};
}
function establish(authentication:Awaited<ReturnType<typeof createSession>>,res:Response):Session {
  res.cookie('gonglun_session',authentication.raw,{httpOnly:true,sameSite:'strict',secure:res.req.secure,maxAge:30*86400000,path:'/'});
  return authentication.session;
}
export async function register(store:Store,input:unknown,res:Response) {
  const data=credentials.extend({...agreementFields,...signingFields}).parse(normalizeCredentials(input)),salt=token();
  requireAgreement(data.acceptedAgreementVersion);
  const password=`${salt}:${(await derivePassword(data.password,salt,64) as Buffer).toString('hex')}`;
  const userId=id();
  const result=await store.transaction(async()=>{
    if(await store.db.prepare('SELECT 1 FROM users WHERE lower(name)=lower($1)').get(data.name)) throw new DomainError('用户名已存在',409);
    await store.db.prepare('INSERT INTO users(id,name,password,founder) VALUES ($1,$2,$3,0)').run(userId,data.name,password);
    await recordAgreement(store,userId);
    await store.db.prepare('INSERT INTO accounts VALUES ($1,0,0,0,0)').run(userId);
    await bindKey(store,userId,data.deviceId,data.publicKey);
    const tx=new Mutation(store),rules=await store.rules(),grant=rules.initialGrant;
    tx.createdAccountIds = [userId];
    if (grant > 0) {
      const message=await distribution(tx,undefined,{source:'grant',total:grant,ruleVersion:rules.version,inputs:{reason:'initial-grant'},allocations:[{userId,amount:grant,reason:'初始发放',messageIds:[]}]});
      await store.ledger(userId,message.id,grant,0,'初始发放');
      await store.set('minted',integer(await store.setting<number>('minted')+grant));
    }
    const change=await tx.commit();
    return {authentication:await createSession(store,userId,data.deviceId),change};
  });
  return {session:establish(result.authentication,res),change:result.change};
}
export async function login(store:Store,input:unknown,res:Response):Promise<Session> {
  const data=credentials.extend({...agreementFields,...signingFields}).parse(normalizeCredentials(input));
  const row=await store.db.prepare('SELECT id,password FROM users WHERE lower(name)=lower($1)').get(data.name) as {id:string;password:string}|undefined;
  let valid=false;
  if(row && /^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/.test(row.password)) {
    valid=await compareBcrypt(data.password,row.password.replace(/^\$2y\$/, '$2b$'));
  } else {
    const [salt,encoded]=(row?.password??`${'0'.repeat(64)}:${'0'.repeat(128)}`).split(':');
    const computed=await derivePassword(data.password,salt!,64) as Buffer;
    valid=!!row && /^[a-f0-9]{128}$/.test(encoded??'') && timingSafeEqual(computed,Buffer.from(encoded!,'hex'));
  }
  if(!valid||!row) throw new DomainError('用户名或密码错误',401);
  const authentication=await store.sessionTransaction(async()=>{
    await assertActiveAccount(store,row.id,true);
    if (!await store.db.prepare('SELECT 1 FROM participation_acceptances WHERE "userId"=$1 AND version=$2').get(row.id,PARTICIPATION_AGREEMENT_VERSION)) {
      requireAgreement(data.acceptedAgreementVersion);
      await recordAgreement(store,row.id);
    }
    await bindKey(store,row.id,data.deviceId,data.publicKey);
    return createSession(store,row.id,data.deviceId);
  });
  return establish(authentication,res);
}
export async function rotateSigningKey(store:Store,req:Request,res:Response):Promise<Session> {
  const session=await requireCsrf(store,req);
  return login(store,{...req.body,name:session.user.name},res);
}
export async function logout(store:Store,req:Request,res:Response) {
  await requireCsrf(store,req);
  const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('gonglun_session='))?.slice(16);
  if(cookie) await store.db.prepare('DELETE FROM sessions WHERE token=$1').run(hash(cookie));
  res.clearCookie('gonglun_session',{path:'/',httpOnly:true,sameSite:'strict'});
}
