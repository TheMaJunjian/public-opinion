import {createHash} from 'node:crypto';
import type {Reference} from '@gonglun/core';
import type {Store} from './db.js';

const stable=(value:unknown):string=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
export const referenceBasisKey=(reference:Reference)=>createHash('sha256').update(stable(reference)).digest('hex');
/** Fixed evidence is separate from a message's editable content and revision list. */
export async function preservedReferenceBasis(store:Store,reference:Reference):Promise<{value:unknown}|undefined>{
  if(!(await store.db.prepare("SELECT to_regclass('reference_bases') AS name").get())?.name)return undefined;
  return (await store.db.prepare('SELECT body FROM reference_bases WHERE key=$1').get<{body:{value:unknown}}>(referenceBasisKey(reference)))?.body;
}
