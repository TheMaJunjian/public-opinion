import { z } from 'zod';
import {createHash} from 'node:crypto';
import {messageReadingKey,originalReadingKey,relations,type ReadingMark} from '@gonglun/core';
import type { Store } from './db.js';
import {bodyVersionSchema} from './reference-schema.js';

export const readingStateSchema = `CREATE TABLE IF NOT EXISTS reading_marks(
  "userId" TEXT NOT NULL, "messageId" TEXT NOT NULL,
  scope TEXT NOT NULL, key TEXT NOT NULL, body JSONB NOT NULL,
  PRIMARY KEY("userId","messageId",scope,key)
);
CREATE TABLE IF NOT EXISTS reading_confirmation_events(position BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,"userId" TEXT NOT NULL,body JSONB NOT NULL);`;

const markSchema = z.object({
  format:z.literal(3),version:bodyVersionSchema.optional(),eventId:z.string().min(1).max(1000).optional(),resultKey:z.string().max(1000).optional(),
  state:z.enum(['READ','UNREAD']).optional(),selection:z.object({versionKey:z.string().max(60000),outcomes:z.record(z.string().max(100)),signature:z.string().max(200)}).strict().optional(),
  messageId:z.string().min(1).max(200), scope:z.enum(['message','original','influence']),
  key:z.string().max(60000), signature:z.string().max(200).optional(), bodySignature:z.string().max(60000).optional(),
  confirmation:z.object({kind:z.enum(['direct','included']),messageId:z.string().min(1).max(200)}).strict().optional(),
}).strict().refine(mark=>(mark.scope==='influence' ? !!mark.key&&!!mark.eventId&&!mark.confirmation : !!mark.version&&mark.key===(mark.scope==='original'?originalReadingKey(mark.messageId):messageReadingKey(mark.messageId))&&!!mark.signature&&(!mark.eventId&&!mark.resultKey))
  &&(mark.scope!=='original'||!mark.version?.corrections.length)
  &&(!mark.confirmation||(mark.confirmation.kind==='direct')===(mark.confirmation.messageId===mark.messageId)));
export const readingUpdateSchema=z.object({marks:z.array(markSchema).min(1).max(500)}).strict();
/** Keep exact version evidence in JSON; PostgreSQL index entries have a size limit. */
export const readingStorageKey=(mark:ReadingMark)=>'v2:'+createHash('sha256').update(JSON.stringify([mark.key,mark.eventId??'',mark.resultKey??''])).digest('hex');

export async function readingState(store:Store,userId:string):Promise<ReadingMark[]> {
  const rows=await store.db.prepare('SELECT body FROM reading_marks WHERE "userId"=$1 ORDER BY "messageId",scope,key').all<{body:ReadingMark}>(userId);
  return rows.map(row=>row.body);
}

/** Session data only: no journal entries, balances, public sequence or notifications. */
export async function markReading(store:Store,userId:string,marks:ReadingMark[]):Promise<ReadingMark[]> {
  const {validateBodyVersion}=await import('./validation.js');
  const {DomainError}=await import('./db.js');
  // Keep one account's private confirmations ordered, independently of money.
  await store.db.prepare("SELECT pg_advisory_xact_lock(hashtext('gonglun-reading'),hashtext($1))").get(userId);
  const updatedAt=new Date().toISOString(),result:ReadingMark[]=[];
  for(const mark of marks){
    // Also validate influence targets; private progress cannot create phantom messages.
    await store.message(mark.messageId);
    if(mark.version){if(mark.version.messageId!==mark.messageId)throw new DomainError('已阅版本与消息不一致');await validateBodyVersion(store,mark.version);}
    const prior=await store.db.prepare('SELECT body FROM reading_marks WHERE "userId"=$1 AND "messageId"=$2 AND scope=$3 AND key=$4').get<{body:ReadingMark}>(userId,mark.messageId,'message',readingStorageKey({messageId:mark.messageId,scope:'message',key:messageReadingKey(mark.messageId)}));
    const wasConfirmed=!!prior?.body.firstConfirmedAt||prior?.body.state==='READ';
    if(mark.scope==='message'&&mark.state!=='UNREAD'&&!wasConfirmed){
      // Establish the first-read boundary against publication of new corrections.
      // Later confirmations and influence acknowledgments need no public lock.
      await store.db.prepare("SELECT pg_advisory_xact_lock_shared(hashtext('gonglun'),hashtext(current_database() || ':' || $1))").get(store.db.schema);
      const original=await store.db.prepare('SELECT body FROM reading_marks WHERE "userId"=$1 AND "messageId"=$2 AND scope=$3 AND key=$4').get<{body:ReadingMark}>(userId,mark.messageId,'original',readingStorageKey({messageId:mark.messageId,scope:'original',key:originalReadingKey(mark.messageId)}));
      if(mark.version?.corrections.length&&(!original||original.body.state==='UNREAD'||original.body.unknownContext))throw new DomainError('请先确认原文已阅');
      const candidates=(await store.db.prepare('SELECT body FROM messages WHERE id IN (SELECT "sourceId" FROM refs WHERE "targetId"=$1)').all(mark.messageId)).map(row=>JSON.parse(String(row.body)));
      const required=candidates.filter(message=>relations(message).some(part=>part.relation==='correct'&&part.roles.target?.some(binding=>binding.reference.messageId===mark.messageId)));
      const reads=await store.db.prepare(`SELECT "messageId" FROM reading_marks WHERE "userId"=$1 AND "messageId"=ANY($2::text[]) AND scope='message' AND body->>'format'='3' AND body->>'state'='READ' AND body->>'unknownContext' IS DISTINCT FROM 'true'`).all(userId,required.map(message=>message.id));
      const confirmed=new Set(reads.map(row=>String(row.messageId))),missing=required.filter(message=>!confirmed.has(message.id));
      if(missing.length)throw new DomainError('请先阅读全部更正消息：'+missing.map(message=>message.id).join('、'));
    }
    if(mark.scope==='influence'&&mark.eventId&&!mark.eventId.startsWith('selection:')){
      let event:unknown;try{event=JSON.parse(mark.eventId);}catch{throw new DomainError('影响确认缺少明确事件');}
      if(!Array.isArray(event)||typeof event[0]!=='string'||!Number.isInteger(event[1]))throw new DomainError('影响确认事件格式不正确');
      const source=await store.message(event[0],event[1]);if(source.sequence!==event[2])throw new DomainError('影响确认事件版本已变化');
    }
    if(mark.confirmation&&mark.confirmation.messageId!==mark.messageId)await store.message(mark.confirmation.messageId);
    const observation=await store.db.prepare('INSERT INTO reading_confirmation_events("userId",body) VALUES($1,$2::jsonb) RETURNING position').get<{position:number}>(userId,JSON.stringify({...mark,updatedAt}));
    const value:ReadingMark={...mark,state:mark.state??'READ',...(mark.scope==='message'?(prior?.body.firstConfirmedAt?{firstConfirmedAt:prior.body.firstConfirmedAt,baselineSequence:prior.body.baselineSequence,originalSeen:prior.body.originalSeen}:mark.state!=='UNREAD'?{firstConfirmedAt:updatedAt,baselineSequence:await store.latestSequence(),...(!mark.version?.corrections.length?{originalSeen:true as const}:{})}:{}):{}),position:Number(observation!.position),updatedAt,...(mark.confirmation?.kind==='direct'&&mark.state!=='UNREAD'?{directConfirmedAt:updatedAt}:{})};
    const saved=await store.db.prepare(`INSERT INTO reading_marks("userId","messageId",scope,key,body) VALUES($1,$2,$3,$4,$5::jsonb)
      ON CONFLICT("userId","messageId",scope,key) DO UPDATE SET body=excluded.body
        || CASE WHEN reading_marks.body ? 'directConfirmedAt' THEN jsonb_build_object('directConfirmedAt',reading_marks.body->'directConfirmedAt') ELSE '{}'::jsonb END
        || CASE WHEN reading_marks.body->>'legacyConfirmation'='true' OR (excluded.body ? 'confirmation' AND NOT (reading_marks.body ? 'confirmation'))
          THEN '{"legacyConfirmation":true}'::jsonb ELSE '{}'::jsonb END
      RETURNING body`)
      .get<{body:ReadingMark}>(userId,mark.messageId,mark.scope,readingStorageKey(mark),JSON.stringify(value));
    result.push(saved!.body);
  }
  return result;
}
