import type {Change,Message} from '@gonglun/core';
import type {Store} from '../../server/src/db.js';
import {recordPersonal} from '../../server/src/personal-actions.js';
import {statesFor} from '../../server/src/projections.js';
import {migrateMessageFormat} from './migrate-message-format.js';
import {migrateAnnotationReasons} from './migrate-annotation-reasons.js';

/** New versions also repair databases already stamped by the previous release. */
export async function completeMessageFormats(store:Store){
  const repairs=new Map<string,Set<string>>();
  if((await store.db.prepare("SELECT to_regclass('annotation_reason_backups') AS name").get())?.name){
    for(const row of await store.db.prepare("SELECT body FROM annotation_reason_backups WHERE table_name='revisions'").all()){
      const original=JSON.parse(String(row.body)) as Message;
      const data=Object.assign({},...original.parts.flatMap(part=>part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value)?[part.value]:[]));
      for(const part of original.parts)if(part.type==='relation'&&['follow','block'].includes(part.relation)&&part.reason===undefined
        &&data.subType!=='YES'&&data.subType!=='NO'&&data.action===`un${part.relation}`){
        const key=`${original.id}:${original.revision}`,parts=repairs.get(key)??new Set<string>();parts.add(part.id);repairs.set(key,parts);
      }
    }
  }
  const repaired=repairs.size?await migrateAnnotationReasons(store,repairs):0;
  const changed=await migrateMessageFormat(store)+repaired;
  for(const row of await store.db.prepare("SELECT body FROM revisions WHERE revision=1 AND body LIKE '%recommend%'").all()){
    const original=JSON.parse(String(row.body)) as Message;
    await recordPersonal(store,{...original,parts:original.parts.filter(part=>part.type==='relation'&&part.relation==='recommend')});
  }
  if(changed){
    const messages=(await store.db.prepare('SELECT body FROM messages ORDER BY id').all()).map(row=>JSON.parse(String(row.body)) as Message);
    const previousSequence=await store.latestSequence();
    const sequence=Number((await store.db.prepare("INSERT INTO changes(body) VALUES('{}') RETURNING sequence").get())!.sequence);
    const change:Change={sequence,previousSequence,messages,memberships:[],removedMemberships:[],states:await statesFor(store,messages.map(message=>message.id)),
      ledger:[],treasury:{operating:await store.setting('operating'),issued:await store.setting('minted')}};
    await store.db.prepare('UPDATE changes SET body=$1 WHERE sequence=$2').run(JSON.stringify(change),sequence);
  }
}
