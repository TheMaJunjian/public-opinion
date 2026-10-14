import { Router } from 'express';
import { relations, textOf, type Message } from '@gonglun/core';
import { z } from 'zod';
import { currentSession, requireCsrf, requireSession, rotateSigningKey, verifyDeviceSignature } from './auth.js';
import { DomainError, id, Store } from './db.js';
import { dataOf } from './economy.js';
import { executeBatch, executeCommand } from './ui-commands.js';
import { accountView, allUsers, attentionUsers, legacyType, messageView, paginate, parentOf, roundView, scopeMessages, snapshot, stakesFor, tagCounts, scopeView, userView, viewsFor, type RecordData } from './ui-projections.js';

/** Transport views for the established interaction model. The domain contains messages only. */
export function createUiRouter(store:Store,publish:()=>void) {
  const router=Router();
  router.get('/snapshot',(req,res,next)=>{try{res.json(snapshot(store,String(req.query.parent??'root'),req.query,currentSession(store,req)?.user.id));}catch(e){next(e);}});
  router.get('/scope',(req,res,next)=>{try{res.json(scopeView(store,String(req.query.parent??'root')));}catch(e){next(e);}});
  router.get('/messages',(req,res,next)=>{try{
    let messages=scopeMessages(store,String(req.query.parent??'root'));if(req.query.sinceUpdatedAt)messages=messages.filter(m=>m.updatedAt>String(req.query.sinceUpdatedAt)||(m.updatedAt===String(req.query.sinceUpdatedAt)&&m.id>String(req.query.sinceId??'')));
    const page=paginate(messages,req.query);res.json({...page,data:viewsFor(store,page.data,String(req.query.parent??'root'))});
  }catch(e){next(e);}});
  router.get('/relations',(req,res,next)=>{try{const page=paginate(scopeMessages(store,String(req.query.parent??'root')).filter(m=>relations(m).some(r=>r.relation!=='member-of')),req.query);res.json({...page,data:viewsFor(store,page.data,String(req.query.parent??'root'))});}catch(e){next(e);}});
  router.get('/attention-users',(req,res,next)=>{try{res.json({data:attentionUsers(store,scopeMessages(store,String(req.query.parent??'root')).map(m=>m.id))});}catch(e){next(e);}});
  router.get('/tag-counts',(req,res,next)=>{try{res.json({counts:tagCounts(viewsFor(store,scopeMessages(store,String(req.query.parent??'root')),String(req.query.parent??'root')))});}catch(e){next(e);}});
  router.get('/export',(req,res,next)=>{try{
    const messages=scopeMessages(store,String(req.query.parent??'root')),views=viewsFor(store,messages,String(req.query.parent??'root'));
    // A local discussion is the viewing scope. Conservation requires the continuous
    // regional execution journal; never pretend a partial ledger is a full replay.
    const changes=store.db.prepare('SELECT body FROM changes ORDER BY sequence').all().map(row=>JSON.parse(String(row.body)));
    const ruleHistory=store.db.prepare('SELECT * FROM rule_versions ORDER BY version').all().map(({body,...row})=>({...row,rules:JSON.parse(String(body))}));
    res.json({format:'gonglun-2',formatVersion:2,exportedAt:new Date().toISOString(),scope:scopeView(store,String(req.query.parent??'root')),messages:views.map(m=>({...m,authorId:m.createdBy.id,author:m.createdBy.username})),relations:views.filter(m=>m.relationType).map(m=>({...m,authorId:m.createdBy.id,author:m.createdBy.username})),users:allUsers(store),rules:store.rules(),ruleHistory,regionId:store.setting('region'),ledgerId:'local',programVersion:'2.0.0',sequence:store.latestSequence(),auditScope:'region',viewScope:{parent:String(req.query.parent??'root')},changes,signatures:store.db.prepare('SELECT * FROM signatures ORDER BY createdAt,messageId').all()});
  }catch(e){next(e);}});
  router.get('/users',(req,res)=>res.json({data:allUsers(store)}));
  router.get('/users/:id',(req,res,next)=>{try{res.json(userView(store,req.params.id));}catch(e){next(e);}});
  router.get('/users/:id/messages',(req,res,next)=>{try{store.user(req.params.id);const rows=store.db.prepare('SELECT body FROM messages WHERE authorId=? ORDER BY createdAt,id').all(req.params.id).map(r=>JSON.parse(String(r.body)) as Message),page=paginate(rows,req.query);res.json({...page,data:viewsFor(store,page.data)});}catch(e){next(e);}});
  router.get('/users/:id/stances',(req,res,next)=>{try{
    store.user(req.params.id);const all=store.db.prepare('SELECT body FROM revisions WHERE revision=1 AND json_extract(body,\'$.authorId\')=? ORDER BY rowid DESC').all(req.params.id).map(r=>JSON.parse(String(r.body)) as Message);
    const scoped=req.query.scopeMessageId?new Set(scopeMessages(store,String(req.query.scopeMessageId)).map(m=>m.id)):null;
    const rows=all.filter(m=>!scoped||scoped.has(m.id)),stanceRows:RecordData[]=[],tagRows:RecordData[]=[],stakeRows:RecordData[]=[];
    for(const message of rows){const view=messageView(store,message),parent=parentOf(store,message.id),scope=scopeView(store,parent),targets=view.targetRefs.map((r:RecordData)=>r.reference.messageId),target=targets[0]?store.message(targets[0]):null;
      const base={id:message.id,relationMessageId:message.id,scopeMessageId:parent==='root'?null:parent,scopeTitle:scope.title,createdAt:message.createdAt,amount:message.spending.wager,targetMessageId:target?.id??null,content:target?textOf(target):textOf(message)};
      if(['AGREE','DISAGREE'].includes(view.relationType))stanceRows.push({...base,kind:'relation',type:view.relationType,messageKind:target?messageView(store,target).kind:'TEXT',targetRelationType:target?legacyType(target):null});
      if(['TAG','RECOMMEND','ARCHIVE'].includes(view.relationType))tagRows.push({...base,kind:'tag',relationType:view.relationType,label:view.payload.label??view.payload.title??view.relationType,subType:view.payload.subType??null,customLabel:view.payload.customLabel??null,amount:message.spending.recommendation});
      if(message.spending.wager)stakeRows.push({...base,kind:'stake',messageId:target?.id??message.id,messageKind:target?messageView(store,target).kind:view.kind});
    }
    const page=Math.max(1,Number(req.query.page)||1),limit=Math.min(200,Math.max(1,Number(req.query.limit)||30)),slice=(rows:RecordData[])=>rows.slice((page-1)*limit,page*limit);
    res.json({user:{id:req.params.id},stances:{relations:slice(stanceRows),stakes:slice(stakeRows),tags:slice(tagRows)},pagination:{page,limit,totalRelations:stanceRows.length,totalStakes:stakeRows.length,totalTags:tagRows.length}});
  }catch(e){next(e);}});
  router.get('/points/balance',(req,res,next)=>{try{res.json(accountView(store,requireSession(store,req).user.id));}catch(e){next(e);}});
  router.get('/points/transactions',(req,res,next)=>{try{
    const session=requireSession(store,req),rows=store.db.prepare('SELECT * FROM ledger WHERE userId=? ORDER BY rowid').all(session.user.id);let available=0;
    const result=rows.map(row=>{available+=Number(row.amount);return {...row,type:Number(row.lockedDelta)>0?'LOCK':Number(row.lockedDelta)<0?'UNLOCK':Number(row.amount)<0?'SPEND':'TRANSFER',balanceAfter:available,data:{reason:row.reason,messageId:row.messageId,messageRevision:row.messageRevision,scopeMessageId:row.messageId?parentOf(store,String(row.messageId)):null,lockedDelta:row.lockedDelta,ruleVersion:row.ruleVersion}};}).reverse();res.json(paginate(result,req.query,100));
  }catch(e){next(e);}});
  router.get('/rules/current',(_req,res)=>{const rules=store.rules(),row=store.db.prepare('SELECT createdAt FROM rule_versions WHERE version=?').get(rules.version);res.json({id:`rule-${rules.version}`,version:rules.version,status:'ACTIVE',description:null,createdAt:row?.createdAt,parameters:{...rules,protocolFee:rules.protocolFee,registrationBonus:rules.initialGrant,minStakeAmount:0,relationMinStake:{}}});});
  router.get('/messages/:id/stakes',(req,res,next)=>{try{store.message(req.params.id);const value=stakesFor(store,[req.params.id])[req.params.id]!;const type=req.query.settlementType;if(type==='TRUTH'||type==='VALUE'){value.pool=value.pools[type];value.counts=value.countsByType[type];value.stakes=value.stakes.filter((stake:RecordData)=>stake.settlementType===type);}res.json(value);}catch(e){next(e);}});
  router.get('/messages/:id/rounds',(req,res,next)=>{try{store.message(req.params.id);const rows=store.db.prepare("SELECT id FROM rounds WHERE json_extract(body,'$.target.messageId')=? OR json_extract(body,'$.subjectId')=? ORDER BY rowid DESC").all(req.params.id,req.params.id),user=currentSession(store,req)?.user.id;res.json({data:rows.map(row=>roundView(store,String(row.id),user))});}catch(e){next(e);}});
  router.get('/rounds/:id',(req,res,next)=>{try{res.json(roundView(store,req.params.id,currentSession(store,req)?.user.id));}catch(e){next(e);}});
  router.get('/audit-logs',(req,res,next)=>{try{
    let messages=req.query.scopeMessageId?scopeMessages(store,String(req.query.scopeMessageId)):scopeMessages(store);
    if(req.query.actorId)messages=messages.filter(m=>m.authorId===req.query.actorId);
    if(req.query.entityId)messages=messages.filter(m=>m.id===req.query.entityId||m.parts.some(p=>p.type==='relation'&&Object.values(p.roles).flat().some(b=>b.reference.messageId===req.query.entityId)));
    let rows=messages.reverse().map(m=>{const type=legacyType(m),signature=store.db.prepare('SELECT publicKey,signature,payload,deviceId FROM signatures WHERE messageId=?').get(m.id);return {id:m.id,actorId:m.authorId,actor:userView(store,m.authorId),action:type?`${type}_CREATED`:'MESSAGE_CREATED',entityType:'Message',entityId:m.id,scopeMessageId:parentOf(store,m.id)==='root'?null:parentOf(store,m.id),createdAt:m.createdAt,signature,data:{summary:textOf(m)||type,details:{parts:m.parts,spending:m.spending,ruleVersion:m.ruleVersion,programVersion:m.programVersion,revision:m.revision}}};});
    if(req.query.action)rows=rows.filter(row=>row.action===req.query.action);if(req.query.entityType)rows=rows.filter(row=>row.entityType===req.query.entityType);res.json(paginate(rows,req.query));
  }catch(e){next(e);}});
  router.get('/revenue/pool',(_req,res)=>{
    const distributed=store.db.prepare("SELECT COALESCE(SUM(json_extract(p.value,'$.value.total')),0) AS n FROM revisions m,json_each(m.body,'$.parts') p WHERE m.revision=1 AND json_extract(p.value,'$.type')='data' AND json_extract(p.value,'$.value.source')='operations'").get()!;
    const balance=store.setting<number>('operating'),totalDistributed=Number(distributed.n);res.json({id:'local',balance,totalDistributed,totalReceived:balance+totalDistributed,updatedAt:new Date().toISOString()});
  });
  router.get('/revenue/distributions',(req,res,next)=>{try{
    const messages=store.db.prepare("SELECT body FROM revisions WHERE revision=1 AND EXISTS(SELECT 1 FROM json_each(body,'$.parts') p WHERE json_extract(p.value,'$.value.source')='operations') ORDER BY rowid DESC").all().map(r=>JSON.parse(String(r.body)) as Message);
    const rows=messages.flatMap(m=>{const data=dataOf(m);return (data.allocations as unknown as RecordData[]??[]).map((a,index)=>({id:`${m.id}:${index}`,messageId:m.id,userId:a.userId,user:userView(store,a.userId),amount:a.amount,reason:a.reason,messageIds:a.messageIds,createdAt:m.createdAt}));});res.json(paginate(rows,req.query));
  }catch(e){next(e);}});
  router.post('/auth/signing-key',(req,res,next)=>{try{const session=rotateSigningKey(store,req,res);res.json({message:'设备签名密钥已更新',user:session.user,session});}catch(e){next(e);}});
  router.post('/commands',(req,res,next)=>{try{const session=requireCsrf(store,req),signature=verifyDeviceSignature(store,req,session);const parsed=z.object({requestId:z.string()}).passthrough().parse(req.body);if(req.get('x-request-id')&&req.get('x-request-id')!==parsed.requestId)throw new DomainError('请求编号不一致');const result=executeBatch(store,session.user,req.body,signature);publish();res.status(201).json(result);}catch(e){next(e);}});
  router.use((req,res,next)=>{if(req.method!=='POST'&&req.method!=='PATCH'){next();return;}try{const session=requireCsrf(store,req),signature=verifyDeviceSignature(store,req,session),requestId=req.get('x-request-id')??id();const result=executeCommand({store,user:session.user,requestId,signature},req.method,req.path,req.body);publish();res.status(req.method==='POST'?201:200).json(result);}catch(e){next(e);}});
  return router;
}
