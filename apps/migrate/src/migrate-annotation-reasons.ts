import type { Message } from '@gonglun/core';
import type { Store } from '../../server/src/db.js';

import {upgradeAnnotationRecords} from './annotation-format.js';
export {upgradeAnnotationRecords} from './annotation-format.js';

/** One transactional rewrite; primary keys, revisions, references, balances and action order stay intact. */
export async function migrateAnnotationReasons(store: Store,repairs?:ReadonlyMap<string,ReadonlySet<string>>): Promise<number> {
  let changedMessages=0;
  await store.db.exec(`CREATE TABLE IF NOT EXISTS annotation_reason_backups(
    table_name TEXT NOT NULL,row_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(table_name,row_key))`);
  const initial = new Map<string,Message>();
  const tables = [
    {name:'messages',column:'body',key:'id'},
    {name:'revisions',column:'body',key:'jsonb_build_array("messageId",revision)::text'},
    {name:'changes',column:'body',key:'sequence::text'},
    {name:'requests',column:'result',key:'jsonb_build_array("userId","requestId")::text'},
    {name:'command_requests',column:'result',key:'jsonb_build_array("userId","requestId")::text'},
  ];
  for (const table of tables) {
    let after = '';
    for (;;) {
      const rows = await store.db.prepare(`SELECT ${table.key} AS row_key,${table.column} AS body FROM ${table.name}
        WHERE ${table.key}>$1 AND ${table.column} ~ '(follow|unfollow|block|unblock|ATTENTION|UNFOLLOW|BLOCK|UNBLOCK)'
        ORDER BY ${table.key} LIMIT 200`).all(after);
      if (!rows.length) break;
      for (const row of rows) {
        const original = JSON.parse(String(row.body)), upgraded = upgradeAnnotationRecords(original,repairs);
        if (JSON.stringify(original) === JSON.stringify(upgraded)) continue;
        await store.db.prepare('INSERT INTO annotation_reason_backups VALUES ($1,$2,$3) ON CONFLICT DO NOTHING')
          .run(table.name,row.row_key,row.body);
        await store.db.prepare(`UPDATE ${table.name} SET ${table.column}=$1 WHERE ${table.key}=$2`).run(JSON.stringify(upgraded),row.row_key);
        if(table.name==='messages')changedMessages++;
        if (table.name === 'revisions' && upgraded.revision === 1) initial.set(upgraded.id,upgraded as Message);
      }
      after = String(rows.at(-1)!.row_key);
    }
  }
  // Rebuild only the affected personal actions from the initial execution, never from edited versions.
  if (initial.size) {
    const sources = [...initial.keys()];
    await store.db.prepare("DELETE FROM personal_actions WHERE \"sourceId\"=ANY($1::text[]) AND family IN ('follow','block')").run(sources);
    for (const message of initial.values()) for (const [index,part] of message.parts.entries()) {
      if (part.type !== 'relation' || !['follow','block'].includes(part.relation)) continue;
      for (const binding of part.roles.target ?? []) await store.db.prepare(`INSERT INTO personal_actions
        ("authorId","targetId",family,action,sequence,"sourceId","partId","partOrder") VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`)
        .run(message.authorId,binding.reference.messageId,part.relation,part.reason === 'NO' ? `un${part.relation}` : part.relation,
          message.sequence,message.id,part.id,index);
    }
    await store.db.exec(`DELETE FROM personal_marks WHERE family IN ('follow','block');
      INSERT INTO personal_marks SELECT DISTINCT ON("authorId","targetId",family)
        "authorId","targetId",family,action,sequence,"sourceId","partId","partOrder" FROM personal_actions
        WHERE family IN ('follow','block') ORDER BY "authorId","targetId",family,sequence DESC,"sourceId" DESC,"partOrder" DESC`);
  }
  return changedMessages;
}
