import { randomBytes, scrypt, timingSafeEqual, createHash, createPublicKey, verify } from 'node:crypto';
import { promisify } from 'node:util';
import { compare as compareBcrypt } from 'bcryptjs';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Session } from '@gonglun/core';
import { DomainError, id, integer, Mutation, Store } from './db.js';
import { distribution } from './economy.js';

const credentials=z.object({name:z.string().trim().min(2).max(40).regex(/^[\p{L}\p{N}_ .-]+$/u),password:z.string().min(8).max(128)}).strict();
const derivePassword=promisify(scrypt);
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const token=()=>randomBytes(32).toString('hex');
const signingFields={publicKey:z.string().max(4000).nullable().optional(),deviceId:z.string().min(1).max(100).optional()};
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
export async function currentSession(store:Store,req:Request):Promise<Session|null> {
  const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('gonglun_session='))?.slice(16);
  if(!cookie) return null;
  const row=await store.db.prepare('SELECT "userId",csrf,expires,"deviceId" FROM sessions WHERE token=$1').get(hash(cookie)) as {userId:string;csrf:string;expires:number;deviceId?:string}|undefined;
  if(!row||row.expires<Date.now()) return null;
  const key=row.deviceId?await store.db.prepare('SELECT "publicKey" FROM signing_keys WHERE "userId"=$1 AND "deviceId"=$2').get(row.userId,row.deviceId):undefined;
  return {user:{...await store.user(row.userId),...(key?{publicKey:String(key.publicKey)}:{})},account:await store.account(row.userId),rules:await store.rules(),csrf:row.csrf};
}
export async function requireSession(store:Store,req:Request):Promise<Session> {
  const session=await currentSession(store,req); if(!session) throw new DomainError('请先登录',401); return session;
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
async function establish(store:Store,userId:string,res:Response,deviceId?:string):Promise<Session> {
  const raw=token(), csrf=token();
  await store.db.prepare('DELETE FROM sessions WHERE expires<$1').run(Date.now());
  await store.db.prepare('INSERT INTO sessions(token,"userId",csrf,expires,"deviceId") VALUES ($1,$2,$3,$4,$5)').run(hash(raw),userId,csrf,Date.now()+30*86400000,deviceId??null);
  res.cookie('gonglun_session',raw,{httpOnly:true,sameSite:'strict',secure:res.req.secure,maxAge:30*86400000,path:'/'});
  const key=deviceId?await store.db.prepare('SELECT "publicKey" FROM signing_keys WHERE "userId"=$1 AND "deviceId"=$2').get(userId,deviceId):undefined;
  return {user:{...await store.user(userId),...(key?{publicKey:String(key.publicKey)}:{})},account:await store.account(userId),rules:await store.rules(),csrf};
}
export async function register(store:Store,input:unknown,res:Response) {
  const data=credentials.extend({founderKey:z.string().max(200).optional(),...signingFields}).parse(normalizeCredentials(input)),salt=token();
  const password=`${salt}:${(await derivePassword(data.password,salt,64) as Buffer).toString('hex')}`;
  const userId=id();
  const result=await store.transaction(async()=>{
    if(await store.db.prepare('SELECT 1 FROM users WHERE lower(name)=lower($1)').get(data.name)) throw new DomainError('用户名已存在',409);
    const founder=!await store.db.prepare('SELECT 1 FROM users LIMIT 1').get();
    if(founder&&process.env.NODE_ENV==='production') {
      const configured=process.env.GONGLUN_FOUNDER_KEY;
      if(!configured)throw new DomainError('请先配置初始发起人密钥再注册',503);
      if(!data.founderKey||!timingSafeEqual(Buffer.from(hash(data.founderKey),'hex'),Buffer.from(hash(configured),'hex')))throw new DomainError('初始发起人密钥错误',403);
    }
    await store.db.prepare('INSERT INTO users(id,name,password,founder) VALUES ($1,$2,$3,$4)').run(userId,data.name,password,founder?1:0);
    await store.db.prepare('INSERT INTO accounts VALUES ($1,0,0,0,0)').run(userId);
    await bindKey(store,userId,data.deviceId,data.publicKey);
    const tx=new Mutation(store),rules=await store.rules(),grant=rules.initialGrant;
    const message=await distribution(tx,undefined,{source:'grant',total:grant,ruleVersion:rules.version,inputs:{reason:'initial-grant'},allocations:[{userId,amount:grant,reason:'初始发放',messageIds:[]}]});
    await store.ledger(userId,message.id,grant,0,'初始发放');
    await store.set('minted',integer(await store.setting<number>('minted')+grant));
    return tx.commit();
  });
  return {session:await establish(store,userId,res,data.deviceId),change:result};
}
export async function login(store:Store,input:unknown,res:Response):Promise<Session> {
  const data=credentials.extend({password:z.string().min(1).max(128),...signingFields}).parse(normalizeCredentials(input));
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
  await bindKey(store,row.id,data.deviceId,data.publicKey);
  return establish(store,row.id,res,data.deviceId);
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
