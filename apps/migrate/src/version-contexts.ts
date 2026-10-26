import {bodyVersion,bodyVersionKey,type Message,type ReadingMark, type Change} from '@gonglun/core';
import type {Store} from '../../server/src/db.js';
import {readingStateSchema,readingStorageKey} from '../../server/src/reading-state.js';
import {statesFor} from '../../server/src/projections.js';
import {createVersionContextTransform} from './version-context-format.js';

function oldOriginalKey(content:string){
  const value=JSON.stringify([content,[],[],false,undefined]);let a=2166136261,b=5381;
  for(let i=0;i<value.length;i++){a=Math.imul(a^value.charCodeAt(i),16777619);b=Math.imul(b,33)^value.charCodeAt(i);}
  return `display:1:${value.length}:${(a>>>0).toString(36)}:${(b>>>0).toString(36)}`;
}
export async function migrateVersionContexts(store:Store){
  await store.db.exec(readingStateSchema);
  await store.db.exec('ALTER TABLE display_stances ADD COLUMN IF NOT EXISTS context JSONB');
  await store.db.exec(`DROP INDEX IF EXISTS round_target;CREATE INDEX round_target ON rounds USING hash("targetKey");
    DROP INDEX IF EXISTS bets_target;CREATE INDEX bets_target ON bets USING hash("targetKey");
    DROP INDEX IF EXISTS display_stances_target;CREATE INDEX display_stances_target ON display_stances("targetId","targetRevision","authorId",md5("targetKey"),sequence DESC,"sourceId" DESC);`);
  await store.db.exec('CREATE TABLE IF NOT EXISTS version_context_backups(table_name TEXT NOT NULL,row_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(table_name,row_key))');
  await store.db.exec('CREATE TABLE IF NOT EXISTS reading_migration_archive("userId" TEXT NOT NULL,"messageId" TEXT NOT NULL,scope TEXT NOT NULL,key TEXT NOT NULL,body JSONB NOT NULL,PRIMARY KEY("userId","messageId",scope,key))');
  const latest=new Map((await store.db.prepare('SELECT body FROM messages').all()).map(row=>{const m=JSON.parse(String(row.body)) as Message;return [m.id,m] as const;}));
  const originals=new Map((await store.db.prepare('SELECT body FROM revisions').all()).map(row=>{const m=JSON.parse(String(row.body)) as Message;return [`${m.id}:${m.revision}`,m] as const;}));
  const transform=createVersionContextTransform(latest,originals);
  let changed=0;
  for(const table of [{name:'messages',key:'id',column:'body'},{name:'revisions',key:'jsonb_build_array("messageId",revision)::text',column:'body'},
    {name:'changes',key:'sequence::text',column:'body'},{name:'requests',key:'jsonb_build_array("userId","requestId")::text',column:'result'},{name:'command_requests',key:'jsonb_build_array("userId","requestId")::text',column:'result'}]){
    for(const row of await store.db.prepare(`SELECT ${table.key} AS key,${table.column} AS body FROM ${table.name}`).all()){
      const old=JSON.parse(String(row.body)),next=transform(old);if(JSON.stringify(old)===JSON.stringify(next))continue;
      await store.db.prepare('INSERT INTO version_context_backups VALUES($1,$2,$3) ON CONFLICT DO NOTHING').run(table.name,row.key,row.body);
      await store.db.prepare(`UPDATE ${table.name} SET ${table.column}=$1 WHERE ${table.key}=$2`).run(JSON.stringify(next),row.key);changed++;
    }
  }
  for(const row of await store.db.prepare('SELECT "userId","messageId",scope,key,body FROM reading_marks ORDER BY body->>\'updatedAt\',"messageId",key').all()){
    const mark=row.body as ReadingMark;if(mark.format===2){
      const key=readingStorageKey(mark);if(key!==row.key){
        await store.db.prepare('DELETE FROM reading_marks WHERE "userId"=$1 AND "messageId"=$2 AND scope=$3 AND key=$4').run(row.userId,row.messageId,row.scope,row.key);
        await store.db.prepare('INSERT INTO reading_marks VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING').run(row.userId,row.messageId,row.scope,key,JSON.stringify(mark));
      }
      continue;
    }
    await store.db.prepare('INSERT INTO reading_migration_archive VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING').run(row.userId,row.messageId,row.scope,row.key,JSON.stringify(mark));
    const original=latest.get(mark.messageId),content=original?.parts.flatMap(part=>part.type==='text'?[part.text]:part.type==='code'?[part.source]:part.type==='web'?[part.excerpt||part.url]:[]).join('\n');
    await store.db.prepare('DELETE FROM reading_marks WHERE "userId"=$1 AND "messageId"=$2 AND scope=$3 AND key=$4').run(row.userId,row.messageId,row.scope,row.key);
    if(original?.revision===1&&content!==undefined&&mark.scope!=='influence'&&mark.bodySignature===oldOriginalKey(content)&&(!mark.confirmation||mark.confirmation.kind==='direct'||mark.directConfirmedAt)){
      const version=bodyVersion(original.id,original.revision),key=bodyVersionKey(version);
      const value:ReadingMark={...mark,format:2,version,key,bodySignature:key,state:'READ'};
      await store.db.prepare('INSERT INTO reading_marks VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING').run(row.userId,row.messageId,row.scope,readingStorageKey(value),JSON.stringify(value));
    }else{
      const key=`unknown:2:${row.scope}:${row.key}`,value:ReadingMark={...mark,format:2,unknownContext:true,key};
      await store.db.prepare('INSERT INTO reading_marks VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING').run(row.userId,row.messageId,row.scope,readingStorageKey(value),JSON.stringify(value));
    }
  }
  // Existing bets, rounds, stake positions and execution_stances are untouched.
  // Their exact legacy targets remain the contract basis, not inferred contexts.
  if(changed){
    const messages=(await store.db.prepare('SELECT body FROM messages ORDER BY id').all()).map(row=>JSON.parse(String(row.body)) as Message);
    const previousSequence=await store.latestSequence(),sequence=Number((await store.db.prepare("INSERT INTO changes(body) VALUES('{}') RETURNING sequence").get())!.sequence);
    const change:Change={sequence,previousSequence,messages,memberships:[],removedMemberships:[],states:await statesFor(store,messages.map(m=>m.id)),ledger:[],treasury:{operating:await store.setting('operating'),issued:await store.setting('minted')}};
    await store.db.prepare('UPDATE changes SET body=$1 WHERE sequence=$2').run(JSON.stringify(change),sequence);
  }
}
