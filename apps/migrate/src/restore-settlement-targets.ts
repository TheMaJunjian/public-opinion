import {relations,type Change,type Message} from '@gonglun/core';
import type {Store} from '../../server/src/db.js';
import {Postgres} from '../../server/src/postgres.js';
import {statesFor} from '../../server/src/projections.js';
import {migrateMessageFormat} from './migrate-message-format.js';
import {restoreSettlementTargetParts,type LegacySettlementSource} from './settlement-target-format.js';
import {partsSchema} from '../../server/src/validation.js';

export async function archivedSettlementSources(db:Postgres):Promise<Map<string,LegacySettlementSource>> {
  const sources=new Map<string,LegacySettlementSource>();
  const add=(original:{id:string;kind:LegacySettlementSource['kind'];targetRefs?:unknown[]})=>{
    if(!Array.isArray(original.targetRefs)||!original.targetRefs.length||sources.has(original.id))return;
    sources.set(original.id,{kind:original.kind,targetRefs:original.targetRefs});
  };
  if((await db.prepare("SELECT to_regclass('legacy_records') AS name").get())?.name)
    for(const row of await db.prepare(`SELECT body FROM legacy_records WHERE "tableName"='Message' AND body->>'kind' IN ('ROUND','ROUND_RESULT')`).all()){
      if(sources.has(row.body.id))throw new Error(`结算原始归档消息重复：${row.body.id}`);
      add(row.body);
    }
  if((await db.prepare("SELECT to_regclass('message_format_backups') AS name").get())?.name){
    for(const row of await db.prepare("SELECT body FROM message_format_backups WHERE table_name='messages'").all()){
      const message=JSON.parse(String(row.body)) as Message;
      const data=Object.assign({},...message.parts.flatMap(part=>part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value)?[part.value]:[]));
      if(data.kind==='ROUND'||data.kind==='ROUND_RESULT')add({id:message.id,kind:data.kind,targetRefs:data.legacyTargetRefs});
    }
  }
  // An operator may supply an isolated restore of an older production backup.
  // Only read its original records; never migrate it or change the live connection.
  const sourceUrl=process.env.GONGLUN_SETTLEMENT_SOURCE_DATABASE_URL;
  if(sourceUrl){
    const source=new Postgres(sourceUrl,process.env.GONGLUN_SETTLEMENT_SOURCE_DATABASE_SCHEMA);
    try{await source.read(async()=>{
      if((await source.prepare("SELECT to_regclass('\"Message\"') AS name").get())?.name){
        for(const row of await source.prepare(`SELECT row_to_json(m) AS body FROM "Message" m WHERE kind IN ('ROUND','ROUND_RESULT')`).all())add(row.body);
      }else if((await source.prepare("SELECT to_regclass('legacy_records') AS name").get())?.name){
        for(const row of await source.prepare(`SELECT body FROM legacy_records WHERE "tableName"='Message' AND body->>'kind' IN ('ROUND','ROUND_RESULT')`).all())add(row.body);
      }else throw new Error('补救迁移的备份源没有旧 Message 表或原始归档');
    });}finally{await source.close();}
  }
  return sources;
}

/** Uses only archived IDs and stored references; planning never writes or upgrades a database. */
export async function settlementTargetRepairPlan(db:Postgres){
  const sources=await archivedSettlementSources(db);
  const latest=new Map((await db.prepare('SELECT body FROM messages').all()).map(row=>{const message=JSON.parse(String(row.body)) as Message;return [message.id,message];}));
  const originals=new Map((await db.prepare('SELECT body FROM revisions').all()).map(row=>{const message=JSON.parse(String(row.body)) as Message;return [`${message.id}:${message.revision}`,message];}));
  const pending:string[]=[],unresolved:string[]=[];
  let rounds=0,results=0;
  for(const [id,original] of latest){
    const message=structuredClone(original);
    try{
      const data=Object.assign({},...message.parts.flatMap(part=>part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value)?[part.value]:[]));
      if(restoreSettlementTargetParts(message,latest,originals,sources.get(id))){partsSchema.parse(message.parts);pending.push(id);if(data.kind==='ROUND_RESULT')results++;else rounds++;}
      else if(['ROUND','ROUND_RESULT'].includes(data.kind)&&!relations(message).some(part=>part.roles.target?.length))unresolved.push(id);
    }
    catch(error){throw new Error(`结算引用预检失败 ${id}：${(error as Error).message}`);}
  }
  return {archivedRecords:sources.size,pending:pending.length,rounds,results,unresolved:unresolved.length,sampleIds:pending.slice(0,10),unresolvedSampleIds:unresolved.slice(0,10)};
}

/** Versioned, transactional format repair; it never invokes message execution or payout code. */
export async function restoreArchivedSettlementTargets(store:Store){
  const plan=await settlementTargetRepairPlan(store.db);
  if(plan.unresolved)throw new Error(`有 ${plan.unresolved} 条旧结算消息缺少可恢复的原始目标；请提供原始备份源 GONGLUN_SETTLEMENT_SOURCE_DATABASE_URL`);
  const sources=await archivedSettlementSources(store.db);
  const changed=await migrateMessageFormat(store,sources);
  const remaining=await settlementTargetRepairPlan(store.db);
  if(remaining.pending||remaining.unresolved)throw new Error('结算目标引用恢复后仍有遗漏');
  if(changed){
    const messages=(await store.db.prepare('SELECT body FROM messages ORDER BY id').all()).map(row=>JSON.parse(String(row.body)) as Message);
    const previousSequence=await store.latestSequence();
    const sequence=Number((await store.db.prepare("INSERT INTO changes(body) VALUES('{}') RETURNING sequence").get())!.sequence);
    const change:Change={sequence,previousSequence,messages,memberships:[],removedMemberships:[],states:await statesFor(store,messages.map(message=>message.id)),
      ledger:[],treasury:{operating:await store.setting('operating'),issued:await store.setting('minted')}};
    await store.db.prepare('UPDATE changes SET body=$1 WHERE sequence=$2').run(JSON.stringify(change),sequence);
  }
  return changed;
}
