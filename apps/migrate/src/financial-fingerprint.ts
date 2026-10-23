import {createHash} from 'node:crypto';
import type {Postgres} from '../../server/src/postgres.js';

/** Verify existing balances and every ledger row without retaining them in memory. */
export async function financialFingerprint(db:Postgres):Promise<string|null>{
  if(!(await db.prepare("SELECT to_regclass('accounts') AS accounts,to_regclass('ledger') AS ledger").get())?.ledger)return null;
  const hash=createHash('sha256');
  for(const [table,key] of [['accounts','userId'],['ledger','id']]){
    hash.update(table);let after='';
    for(;;){
      const rows=await db.prepare(`SELECT row_to_json(t) AS body FROM ${table} t WHERE "${key}">$1 ORDER BY "${key}" LIMIT 500`).all(after);
      if(!rows.length)break;
      for(const row of rows){hash.update(JSON.stringify(row.body));after=String(row.body[key!]);}
    }
  }
  for(const row of await db.prepare("SELECT key,value FROM settings WHERE key IN ('operating','minted') ORDER BY key").all())hash.update(JSON.stringify(row));
  return hash.digest('hex');
}
