import {randomUUID} from 'node:crypto';
import {relations,type Message,type ReadingMark} from '@gonglun/core';
import type {Store} from '../../server/src/db.js';

const containerTypes=new Set(['classify','summary','merge','arrange']);
type Row={userId:string;messageId:string;scope:ReadingMark['scope'];key:string;body:ReadingMark};
type Candidate=Row&{reason:'duplicate-container-influence'|'included-container-body'};

async function candidates(store:Pick<Store,'db'>){
  const db=store.db,messages=(await db.prepare('SELECT body FROM messages').all()).map(row=>JSON.parse(String(row.body)) as Message);
  const containers=new Map(messages.flatMap(message=>{
    const part=relations(message).find(part=>containerTypes.has(part.relation));return part?[[message.id,part.relation] as const]:[];
  }));
  const disabled=new Set((await db.prepare('SELECT id FROM membership_actions WHERE disabled').all()).map(row=>String(row.id)));
  for(const row of await db.prepare('SELECT "messageId" FROM message_state_checkpoints WHERE body->>\'membershipDisabled\'=\'true\'').all())disabled.add(String(row.messageId));
  const retired=new Set<string>();
  for(const row of await db.prepare("SELECT value FROM settings WHERE key IN ('retired-organizations','retired-legacy-topics')").all()){
    const ids=JSON.parse(String(row.value));if(Array.isArray(ids))for(const id of ids)if(typeof id==='string')retired.add(id);
  }
  const placements=new Set<string>();
  for(const message of messages)if(!disabled.has(message.id))for(const part of relations(message))if(part.relation==='member-of'){
    for(const parent of part.roles.parent??[])for(const member of part.roles.member??[])
      if(!retired.has(parent.reference.messageId)&&!retired.has(member.reference.messageId))placements.add(JSON.stringify([parent.reference.messageId,member.reference.messageId]));
  }
  const rows=await db.prepare('SELECT "userId","messageId",scope,key,body FROM reading_marks ORDER BY "userId","messageId",scope,key').all<Row>();
  const removed:Candidate[]=[];let preservedDirect=0,preservedUnknown=0;
  for(const row of rows){
    if(row.scope==='influence'){
      const prefix=[...containerTypes].find(type=>row.key.startsWith(`${type}:`));
      const parent=prefix&&row.key.slice(prefix.length+1);
      if(parent&&containers.get(parent)===prefix&&placements.has(JSON.stringify([parent,row.messageId])))removed.push({...row,reason:'duplicate-container-influence'});
    }else if(containers.has(row.messageId)){
      // The old format did not retain confirmation sources. Same-timestamp
      // batches cannot prove that an earlier standalone read never existed.
      const mark=row.body;
      if(mark.directConfirmedAt||mark.confirmation?.kind==='direct')preservedDirect++;
      else if(mark.legacyConfirmation||!mark.confirmation||mark.confirmation.messageId===row.messageId)preservedUnknown++;
      else if(mark.confirmation.kind==='included')removed.push({...row,reason:'included-container-body'});
    }
  }
  return {removed,preservedDirect,preservedUnknown};
}

export async function containerReadingCleanupPlan(store:Pick<Store,'db'>){
  const plan=await candidates(store);
  return {pending:plan.removed.length,duplicateInfluences:plan.removed.filter(row=>row.reason==='duplicate-container-influence').length,
    includedBodies:plan.removed.filter(row=>row.reason==='included-container-body').length,
    preservedDirect:plan.preservedDirect,preservedUnknown:plan.preservedUnknown};
}

/** Private data only. The migration transaction also preserves an audit copy. */
export async function cleanupContainerReadingMarks(store:Pick<Store,'db'>){
  const plan=await candidates(store),removed:Candidate[]=[];
  for(const row of plan.removed){
    // A simultaneous standalone confirmation must win over the old plan.
    const deleted=await store.db.prepare(`DELETE FROM reading_marks WHERE "userId"=$1 AND "messageId"=$2 AND scope=$3 AND key=$4 AND body=$5::jsonb
      RETURNING "userId","messageId",scope,key,body`).get<Row>(row.userId,row.messageId,row.scope,row.key,JSON.stringify(row.body));
    if(deleted)removed.push({...deleted,reason:row.reason});
  }
  if(removed.length){
    await store.db.exec('CREATE TABLE IF NOT EXISTS container_reading_cleanup_archive(id TEXT PRIMARY KEY,body JSONB NOT NULL)');
    await store.db.prepare('INSERT INTO container_reading_cleanup_archive VALUES($1,$2)').run(randomUUID(),JSON.stringify({removedAt:new Date().toISOString(),records:removed}));
  }
  return removed.length;
}
