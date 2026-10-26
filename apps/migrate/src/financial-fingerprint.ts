import {createHash} from 'node:crypto';
import type {Postgres} from '../../server/src/postgres.js';
import type {LedgerEntry} from '@gonglun/core';

/** Verify existing balances and every ledger row without retaining them in memory. */
export async function financialFingerprint(db:Postgres, additions:LedgerEntry[]=[],operatingDelta=0):Promise<string|null>{
  if(!(await db.prepare("SELECT to_regclass('accounts') AS accounts,to_regclass('ledger') AS ledger").get())?.ledger)return null;
  const hash=createHash('sha256');
  const excluded=new Set(additions.map(entry=>entry.id));
  const deltas=new Map<string,{available:number;locked:number;earned:number;spent:number}>();
  for(const entry of additions){
    const delta=deltas.get(entry.userId)??{available:0,locked:0,earned:0,spent:0};
    delta.available+=entry.amount;delta.locked+=entry.lockedDelta;
    delta.earned+=Math.max(0,entry.amount+entry.lockedDelta);delta.spent+=Math.max(0,-entry.amount-entry.lockedDelta);
    deltas.set(entry.userId,delta);
  }
  for(const [table,key] of [['accounts','userId'],['ledger','id']]){
    hash.update(table);let after='';
    for(;;){
      const rows=await db.prepare(`SELECT row_to_json(t) AS body FROM ${table} t WHERE "${key}">$1 ORDER BY "${key}" LIMIT 500`).all(after);
      if(!rows.length)break;
      for(const row of rows){
        const body=row.body;after=String(body[key!]);
        if(table==='ledger'&&excluded.has(String(body.id)))continue;
        const delta=table==='accounts'?deltas.get(String(body.userId)):undefined;
        if(delta)for(const field of ['available','locked','earned','spent'] as const)body[field]-=delta[field];
        hash.update(JSON.stringify(body));
      }
    }
  }
  for(const row of await db.prepare("SELECT key,value FROM settings WHERE key IN ('operating','minted') ORDER BY key").all()){
    if(row.key==='operating'&&operatingDelta)row.value=JSON.stringify(JSON.parse(String(row.value))-operatingDelta);
    hash.update(JSON.stringify(row));
  }
  return hash.digest('hex');
}
