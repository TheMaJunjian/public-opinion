import express, { type NextFunction, type Request, type Response } from 'express';
import { z, ZodError } from 'zod';
import { resolve } from 'node:path';
import { DomainError, Store } from './db.js';
import { checkOrigin, currentSession, login, logout, register, requireCsrf, requireSession } from './auth.js';
import { processDue, send } from './messages.js';
import { changes, context, listMessages } from './queries.js';
import { markedPage, notifications, personalMessages } from './personal.js';

const query=z.object({parent:z.string().max(100).optional(),cursor:z.string().max(1000).optional(),limit:z.coerce.number().int().min(1).max(100).optional(),q:z.string().max(200).optional(),relation:z.string().max(80).optional(),author:z.string().max(100).optional()}).strict();
const personalQuery=query.extend({filter:z.enum(['normal','follow','read','unread','block','archive']).optional(),after:z.coerce.number().int().nonnegative().optional()});
export function createApp(options:{dbPath?:string;settlementTickMs?:number}={}) {
  const app=express(),store=new Store(options.dbPath??process.env.GONGLUN_DB??resolve('data/gonglun.sqlite'));
  const clients=new Map<Response,{after:number}>();
  let broadcastSequence=store.latestSequence();
  const writeChange=(res:Response,state:{after:number},change:{sequence:number})=>{
    if(res.writableEnded||change.sequence<=state.after)return;
    state.after=change.sequence;
    if(!res.write(`id: ${change.sequence}\ndata: ${JSON.stringify(change)}\n\n`)) {
      // Finish the bounded queued frame, then let EventSource reconnect from its last complete ID.
      clients.delete(res);res.end();
    }
  };
  const publish=()=>{
    for(let batch=0;batch<100;batch++) {
      const page=changes(store,broadcastSequence,100);
      for(const change of page.changes)for(const [res,state] of clients)writeChange(res,state,change);
      broadcastSequence=page.nextCursor;
      if(!page.hasMore)break;
    }
  };
  app.locals.store=store;
  if(process.env.TRUST_PROXY==='loopback')app.set('trust proxy','loopback');
  else if(process.env.TRUST_PROXY==='1')app.set('trust proxy',1);
  app.disable('x-powered-by');
  app.use(express.json({limit:'128kb'}));
  app.use((req,res,next)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    if(req.path.startsWith('/api/'))res.setHeader('Cache-Control','no-store');
    try {if(['POST','PUT','PATCH','DELETE'].includes(req.method))checkOrigin(req);next();}catch(error){next(error);}
  });
  const attempts=new Map<string,{at:number;count:number}>();
  const limitAuth=(req:Request)=>{
    const key=req.ip??'local',now=Date.now(),before=attempts.get(key);
    if(before&&now-before.at<60000){if(++before.count>30)throw new DomainError('尝试过于频繁，请稍后重试',429);}
    else attempts.set(key,{at:now,count:1});
    if(attempts.size>1000)for(const [key,item] of attempts)if(now-item.at>60000)attempts.delete(key);
  };
  app.get('/api/session',(req,res)=>res.json(currentSession(store,req)));
  app.get('/api/me/marks',(req,res,next)=>{try{const session=requireSession(store,req);const input=z.object({ids:z.string().max(11000)}).strict().parse(req.query);res.json(markedPage(store,session.user.id,input.ids.split(',').filter(Boolean)));}catch(error){next(error);}});
  app.get('/api/me/messages',(req,res,next)=>{try{const session=requireSession(store,req);res.json(personalMessages(store,session.user.id,personalQuery.parse(req.query)));}catch(error){next(error);}});
  app.get('/api/me/notifications',(req,res,next)=>{try{const session=requireSession(store,req);res.json(notifications(store,session.user.id,personalQuery.parse(req.query)));}catch(error){next(error);}});
  app.get('/api/health',(_req,res)=>res.json({ok:true}));
  app.get('/api/users/:id',(req,res,next)=>{try{res.json(req.params.id==='system'?{id:'system',name:'公论规则',founder:false}:store.user(req.params.id!));}catch(error){next(error);}});
  app.get('/api/setup',(_req,res)=>{const initialized=!!store.db.prepare('SELECT 1 FROM users LIMIT 1').get();res.json({initialized,founderKeyRequired:!initialized&&process.env.NODE_ENV==='production'});});
  app.post('/api/register',(req,res,next)=>{try{limitAuth(req);res.status(201).json(register(store,req.body,res).session);publish();}catch(error){next(error);}});
  app.post('/api/login',(req,res,next)=>{try{limitAuth(req);res.json(login(store,req.body,res));}catch(error){next(error);}});
  app.post('/api/logout',(req,res,next)=>{try{logout(store,req,res);res.json({ok:true});}catch(error){next(error);}});
  app.get('/api/messages',(req,res,next)=>{try{res.json(listMessages(store,query.parse(req.query)));}catch(error){next(error);}});
  app.get('/api/messages/:id/context',(req,res,next)=>{try{res.json(context(store,req.params.id!));}catch(error){next(error);}});
  app.get('/api/messages/:id',(req,res,next)=>{try{const revision=req.query.revision===undefined?undefined:Number(req.query.revision);if(revision!==undefined&&(!Number.isSafeInteger(revision)||revision<1))throw new DomainError('版本无效');res.json(store.message(req.params.id!,revision));}catch(error){next(error);}});
  app.get('/api/messages/:id/history',(req,res,next)=>{try{
    store.message(req.params.id!);
    const limit=Math.min(100,Math.max(1,Number(req.query.limit)||30));
    const before=req.query.cursor===undefined?Number.MAX_SAFE_INTEGER:Number(req.query.cursor);
    if(!Number.isSafeInteger(before)||before<1)throw new DomainError('版本游标无效');
    const rows=store.db.prepare('SELECT revision,body FROM revisions WHERE messageId=? AND revision<? ORDER BY revision DESC LIMIT ?').all(req.params.id!,before,limit+1);
    res.json({messages:rows.slice(0,limit).map(r=>JSON.parse(r.body as string)),nextCursor:rows.length>limit?String(rows[limit-1]!.revision):null});
  }catch(error){next(error);}});
  app.post('/api/messages',(req,res,next)=>{try{const session=requireCsrf(store,req);res.status(201).json(send(store,session.user,req.body));publish();}catch(error){next(error);}});
  app.get('/api/ledger',(req,res,next)=>{try{
    const session=requireSession(store,req),limit=Math.min(100,Math.max(1,Number(req.query.limit)||30));
    const before=req.query.cursor===undefined?Number.MAX_SAFE_INTEGER:Number(req.query.cursor);
    if(!Number.isSafeInteger(before)||before<1)throw new DomainError('账本游标无效');
    const rows=store.db.prepare('SELECT rowid AS cursor,* FROM ledger WHERE userId=? AND rowid<? ORDER BY rowid DESC LIMIT ?').all(session.user.id,before,limit+1);
    res.json({entries:rows.slice(0,limit).map(({cursor:_cursor,...row})=>row),account:store.account(session.user.id),nextCursor:rows.length>limit?String(rows[limit-1]!.cursor):null});
  }catch(error){next(error);}});
  app.get('/api/rules',(req,res,next)=>{try{
    if(req.query.version===undefined){res.json(store.rules());return;}
    const version=Number(req.query.version);if(!Number.isSafeInteger(version)||version<1)throw new DomainError('规则版本无效');
    const row=store.db.prepare('SELECT body FROM rule_versions WHERE version=?').get(version);if(!row)throw new DomainError('规则版本不存在',404);res.json(JSON.parse(row.body as string));
  }catch(error){next(error);}});
  app.get('/api/rules/history',(req,res,next)=>{try{
    const before=Number(req.query.cursor??Number.MAX_SAFE_INTEGER);if(!Number.isSafeInteger(before)||before<1)throw new DomainError('规则游标无效');
    const rows=store.db.prepare('SELECT * FROM rule_versions WHERE version<? ORDER BY version DESC LIMIT 101').all(before);
    res.json({versions:rows.slice(0,100).map(({body,...row})=>({...row,rules:JSON.parse(body as string)})),nextCursor:rows.length>100?String(rows[99]!.version):null});
  }catch(error){next(error);}});
  app.get('/api/changes',(req,res,next)=>{try{const after=Number(req.query.after??0);const limit=Math.min(100,Math.max(1,Number(req.query.limit)||100));res.json(changes(store,after,limit));}catch(error){next(error);}});
  app.get('/api/events',(req,res,next)=>{
    let after=Number(req.get('Last-Event-ID')??req.query.after??0);
    if(!Number.isSafeInteger(after)||after<0){next(new DomainError('变更游标无效'));return;}
    res.status(200).set({'Content-Type':'text/event-stream','Cache-Control':'no-cache, no-transform',Connection:'keep-alive','X-Accel-Buffering':'no'});res.flushHeaders();
    const state={after};clients.set(res,state);res.write(': connected\n\n');
    for(let batch=0;batch<10&&!res.writableEnded;batch++) {
      const page=changes(store,state.after,100);
      for(const change of page.changes){writeChange(res,state,change);if(res.writableEnded)break;}
      if(!page.hasMore)break;
      if(batch===9){clients.delete(res);res.end();}
    }
    req.on('close',()=>clients.delete(res));
  });
  app.get('/api/export',(req,res,next)=>{try{
    // The export consists only of public records; account authentication material is never selected.
    const after=Number(req.query.after??0),limit=Math.min(100,Math.max(1,Number(req.query.limit)||100));
    const page=changes(store,after,limit);
    const versions=new Set<number>(page.changes.flatMap(change=>change.messages.map((message:{ruleVersion:number})=>message.ruleVersion)));
    const rules=[...versions].map(version=>store.db.prepare('SELECT * FROM rule_versions WHERE version=?').get(version)).filter(Boolean).map(row=>({...row,body:undefined,rules:JSON.parse(row!.body as string)}));
    res.json({format:'gonglun-2',regionId:store.setting('region'),ledgerId:'local',programVersion:'2.0.0',rules:store.rules(),ruleHistory:rules,...page});
  }catch(error){next(error);}});
  app.use('/api',(_req,res)=>res.status(404).json({error:'接口不存在'}));
  app.use((error:unknown,_req:Request,res:Response,_next:NextFunction)=>{
    if(res.headersSent)return;
    if(error instanceof ZodError){res.status(400).json({error:error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('；')});return;}
    if(error instanceof DomainError){res.status(error.status).json({error:error.message});return;}
    if(error instanceof SyntaxError){res.status(400).json({error:'请求 JSON 无效'});return;}
    if((error as {type?:string})?.type==='entity.too.large'){res.status(413).json({error:'消息过大'});return;}
    console.error(error);res.status(500).json({error:'操作失败，所有本次变更已回滚'});
  });
  const timer=setInterval(()=>{try{processDue(store);publish();}catch(error){console.error('延时结算失败',error);}},options.settlementTickMs??1000);timer.unref();
  const heartbeat=setInterval(()=>{for(const [response] of clients)if(!response.write(': heartbeat\n\n')){clients.delete(response);response.end();}},15000);heartbeat.unref();
  let closed=false;
  const close=()=>{if(closed)return;closed=true;clearInterval(timer);clearInterval(heartbeat);for(const [response] of clients)response.end();clients.clear();store.close();};
  app.locals.close=close;
  return Object.assign(app,{store,close});
}
