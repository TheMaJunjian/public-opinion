import { randomBytes, scryptSync, timingSafeEqual, createHash, createPublicKey, verify } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { Session } from '@gonglun/core';
import { DomainError, id, integer, Mutation, Store } from './db.js';
import { distribution } from './economy.js';

const credentials=z.object({name:z.string().trim().min(2).max(40).regex(/^[\p{L}\p{N}_ .-]+$/u),password:z.string().min(8).max(128)}).strict();
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const token=()=>randomBytes(32).toString('hex');
const signingFields={publicKey:z.string().max(4000).nullable().optional(),deviceId:z.string().min(1).max(100).optional()};
function normalizeCredentials(input:unknown) {
  if(!input||typeof input!=='object')return input;
  const {username,...rest}=input as Record<string,unknown>;
  return {...rest,name:rest.name??username};
}
function bindKey(store:Store,userId:string,deviceId:string|undefined,publicKey:string|null|undefined) {
  if(!publicKey)return;
  if(!deviceId)throw new DomainError('绑定签名密钥需要设备编号');
  try {const key=JSON.parse(publicKey);if(key.d||!((key.kty==='OKP'&&key.crv==='Ed25519')||(key.kty==='EC'&&key.crv==='P-256')))throw new Error();createPublicKey({key,format:'jwk'});}catch {throw new DomainError('签名公钥无效');}
  store.db.prepare('INSERT INTO signing_keys VALUES (?,?,?,?) ON CONFLICT(userId,deviceId) DO UPDATE SET publicKey=excluded.publicKey,createdAt=excluded.createdAt').run(userId,deviceId,publicKey,new Date().toISOString());
}
export function currentSession(store:Store,req:Request):Session|null {
  const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('gonglun_session='))?.slice(16);
  if(!cookie) return null;
  const row=store.db.prepare('SELECT userId,csrf,expires,deviceId FROM sessions WHERE token=?').get(hash(cookie)) as {userId:string;csrf:string;expires:number;deviceId?:string}|undefined;
  if(!row||row.expires<Date.now()) return null;
  const key=row.deviceId?store.db.prepare('SELECT publicKey FROM signing_keys WHERE userId=? AND deviceId=?').get(row.userId,row.deviceId):undefined;
  return {user:{...store.user(row.userId),...(key?{publicKey:String(key.publicKey)}:{})},account:store.account(row.userId),rules:store.rules(),csrf:row.csrf};
}
export function requireSession(store:Store,req:Request):Session {
  const session=currentSession(store,req); if(!session) throw new DomainError('请先登录',401); return session;
}
export function requireCsrf(store:Store,req:Request):Session {
  const session=requireSession(store,req);
  if(req.get('x-csrf-token')!==session.csrf) throw new DomainError('会话校验失败，请刷新后重试',403);
  return session;
}
export function verifyDeviceSignature(store:Store,req:Request,session:Session):{deviceId:string;publicKey:string;payload:string;signature:string}|undefined {
  if(!session.user.publicKey)return;
  const deviceId=req.get('x-device-id'),signature=req.get('x-signature');
  if(!deviceId||!signature)throw new DomainError('当前设备已绑定签名密钥，请重新登录以恢复签名',401);
  const row=store.db.prepare('SELECT publicKey FROM signing_keys WHERE userId=? AND deviceId=?').get(session.user.id,deviceId);
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
function establish(store:Store,userId:string,res:Response,deviceId?:string):Session {
  const raw=token(), csrf=token();
  store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
  store.db.prepare('INSERT INTO sessions(token,userId,csrf,expires,deviceId) VALUES (?,?,?,?,?)').run(hash(raw),userId,csrf,Date.now()+30*86400000,deviceId??null);
  res.cookie('gonglun_session',raw,{httpOnly:true,sameSite:'strict',secure:res.req.secure,maxAge:30*86400000,path:'/'});
  const key=deviceId?store.db.prepare('SELECT publicKey FROM signing_keys WHERE userId=? AND deviceId=?').get(userId,deviceId):undefined;
  return {user:{...store.user(userId),...(key?{publicKey:String(key.publicKey)}:{})},account:store.account(userId),rules:store.rules(),csrf};
}
export function register(store:Store,input:unknown,res:Response) {
  const data=credentials.extend({founderKey:z.string().max(200).optional(),...signingFields}).parse(normalizeCredentials(input)),salt=token();
  const password=`${salt}:${scryptSync(data.password,salt,64).toString('hex')}`;
  const userId=id();
  const result=store.transaction(()=>{
    if(store.db.prepare('SELECT 1 FROM users WHERE name=? COLLATE NOCASE').get(data.name)) throw new DomainError('用户名已存在',409);
    const founder=!store.db.prepare('SELECT 1 FROM users LIMIT 1').get();
    if(founder&&process.env.NODE_ENV==='production') {
      const configured=process.env.GONGLUN_FOUNDER_KEY;
      if(!configured)throw new DomainError('请先配置初始发起人密钥再注册',503);
      if(!data.founderKey||!timingSafeEqual(Buffer.from(hash(data.founderKey),'hex'),Buffer.from(hash(configured),'hex')))throw new DomainError('初始发起人密钥错误',403);
    }
    store.db.prepare('INSERT INTO users VALUES (?,?,?,?)').run(userId,data.name,password,founder?1:0);
    store.db.prepare('INSERT INTO accounts VALUES (?,0,0,0,0)').run(userId);
    bindKey(store,userId,data.deviceId,data.publicKey);
    const tx=new Mutation(store),grant=store.rules().initialGrant;
    const message=distribution(tx,undefined,{source:'grant',total:grant,ruleVersion:store.rules().version,inputs:{reason:'initial-grant'},allocations:[{userId,amount:grant,reason:'初始发放',messageIds:[]}]});
    store.ledger(userId,message.id,grant,0,'初始发放');
    store.set('minted',integer(store.setting<number>('minted')+grant));
    return tx.commit();
  });
  return {session:establish(store,userId,res,data.deviceId),change:result};
}
export function login(store:Store,input:unknown,res:Response):Session {
  const data=credentials.extend(signingFields).parse(normalizeCredentials(input));
  const row=store.db.prepare('SELECT id,password FROM users WHERE name=? COLLATE NOCASE').get(data.name) as {id:string;password:string}|undefined;
  const [salt,encoded]=(row?.password??`${'0'.repeat(64)}:${'0'.repeat(128)}`).split(':');
  const computed=scryptSync(data.password,salt!,64);
  if(!row||!timingSafeEqual(computed,Buffer.from(encoded!,'hex'))) throw new DomainError('用户名或密码错误',401);
  bindKey(store,row.id,data.deviceId,data.publicKey);
  return establish(store,row.id,res,data.deviceId);
}
export function rotateSigningKey(store:Store,req:Request,res:Response):Session {
  const session=requireCsrf(store,req);
  return login(store,{...req.body,name:session.user.name},res);
}
export function logout(store:Store,req:Request,res:Response) {
  requireCsrf(store,req);
  const cookie=req.headers.cookie?.split(';').map(s=>s.trim()).find(s=>s.startsWith('gonglun_session='))?.slice(16);
  if(cookie) store.db.prepare('DELETE FROM sessions WHERE token=?').run(hash(cookie));
  res.clearCookie('gonglun_session',{path:'/',httpOnly:true,sameSite:'strict'});
}
