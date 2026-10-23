import {type Message,type Part} from '@gonglun/core';
import type {Store} from '../../server/src/db.js';
import {createMessageFormatTransform} from './message-format.js';
import type {LegacySettlementSource} from './settlement-target-format.js';
import {partsSchema} from '../../server/src/validation.js';

/** Previous formats are interpreted only here; the application receives native parts. */
export async function migrateMessageFormat(store:Store,settlementSources?:Map<string,LegacySettlementSource>):Promise<number>{
  let changedMessages=0;
  const originals=new Map((await store.db.prepare('SELECT body FROM revisions').all()).map(row=>{
    const message=JSON.parse(String(row.body)) as Message;return [`${message.id}:${message.revision}`,message] as const;
  }));
  const latest=new Map((await store.db.prepare('SELECT body FROM messages').all()).map(row=>{const message=JSON.parse(String(row.body)) as Message;return [message.id,message] as const;}));
  const transform=createMessageFormatTransform(latest,originals,settlementSources);
  const tables=[{name:'messages',column:'body',key:'id'},{name:'revisions',column:'body',key:'jsonb_build_array("messageId",revision)::text'},
    {name:'changes',column:'body',key:'sequence::text'},{name:'requests',column:'result',key:'jsonb_build_array("userId","requestId")::text'},
    {name:'command_requests',column:'result',key:'jsonb_build_array("userId","requestId")::text'}];
  await store.db.exec('CREATE TABLE IF NOT EXISTS message_format_backups(table_name TEXT NOT NULL,row_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(table_name,row_key))');
  for(const table of tables)for(const row of await store.db.prepare(`SELECT ${table.key} AS row_key,${table.column} AS body FROM ${table.name}`).all()){
    const old=JSON.parse(String(row.body)),upgraded=transform(old);
    if(JSON.stringify(old)===JSON.stringify(upgraded))continue;
    if(table.name==='messages'||table.name==='revisions')partsSchema.parse(upgraded.parts);
    await store.db.prepare('INSERT INTO message_format_backups VALUES($1,$2,$3) ON CONFLICT DO NOTHING').run(table.name,row.row_key,row.body);
    await store.db.prepare(`UPDATE ${table.name} SET ${table.column}=$1 WHERE ${table.key}=$2`).run(JSON.stringify(upgraded),row.row_key);
    if(table.name==='messages'){
      changedMessages++;
      await store.db.prepare('DELETE FROM refs WHERE "sourceId"=$1').run(upgraded.id);
      const targets=new Set<string>(upgraded.parts.flatMap((part:Part)=>part.type==='relation'?Object.values(part.roles).flat().map(binding=>binding.reference.messageId)
        :part.type==='display'&&part.target?[part.target.messageId]:[]));
      for(const target of targets)await store.db.prepare('INSERT INTO refs VALUES($1,$2) ON CONFLICT DO NOTHING').run(upgraded.id,target);
    }
  }
  return changedMessages;
}
