import type { Context, Membership, Message, Page, User } from '@gonglun/core';
import { DomainError, Store } from './db.js';
import { roundsFor } from './economy.js';
import { statesFor } from './projections.js';

const decode=(row:Record<string,unknown>)=>JSON.parse(row.body as string) as Message;
function cursorValue(cursor:string|undefined):{sequence:number;id:string}|undefined {
  if(!cursor)return;
  try {
    const parsed=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8')) as {sequence:number;id:string};
    if(!Number.isSafeInteger(parsed.sequence)||parsed.sequence<0||typeof parsed.id!=='string'||parsed.id.length>100)throw new Error();
    return parsed;
  } catch {throw new DomainError('分页游标无效');}
}
export function pageFor(store:Store,messages:Message[],nextCursor:string|null=null):Page {
  const authorIds=[...new Set(messages.map(m=>m.authorId))];
  const users:User[]=authorIds.map(userId=>userId==='system'?{id:'system',name:'公论规则',founder:false}:store.user(userId));
  const ids=messages.map(m=>m.id);
  const memberships=ids.length?store.db.prepare(`SELECT * FROM memberships WHERE memberId IN (${ids.map(()=>'?').join(',')})`).all(...ids) as unknown as Membership[]:[];
  return {messages,users,memberships,nextCursor,sequence:store.latestSequence(),states:statesFor(store,ids)};
}
export function listMessages(store:Store,options:{parent?:string;cursor?:string;limit?:number;q?:string;relation?:string;author?:string}):Page {
  const limit=Math.max(1,Math.min(100,options.limit??30)),clauses:string[]=[],params:(string|number)[]=[];
  if(options.parent){store.message(options.parent);clauses.push('EXISTS (SELECT 1 FROM memberships m WHERE m.memberId=messages.id AND m.parentId=?)');params.push(options.parent);}
  else if(!options.q&&!options.author&&!options.relation) clauses.push('NOT EXISTS (SELECT 1 FROM memberships m WHERE m.memberId=messages.id)');
  const cursor=cursorValue(options.cursor);
  if(cursor){clauses.push('(sequence<? OR (sequence=? AND id<?))');params.push(cursor.sequence,cursor.sequence,cursor.id);}
  if(options.q){clauses.push("EXISTS (SELECT 1 FROM json_each(messages.body,'$.parts') p WHERE (json_extract(p.value,'$.text') LIKE ? ESCAPE '\\' OR json_extract(p.value,'$.source') LIKE ? ESCAPE '\\' OR json_extract(p.value,'$.excerpt') LIKE ? ESCAPE '\\'))");const query=`%${options.q.replace(/[\\%_]/g,'\\$&')}%`;params.push(query,query,query);}
  if(options.relation){clauses.push("EXISTS (SELECT 1 FROM json_each(messages.body,'$.parts') p WHERE json_extract(p.value,'$.relation')=?)");params.push(options.relation);}
  if(options.author){clauses.push('authorId=?');params.push(options.author);}
  const rows=store.db.prepare(`SELECT body FROM messages WHERE ${clauses.join(' AND ')} ORDER BY sequence DESC,id DESC LIMIT ?`).all(...params,limit+1);
  const messages=rows.slice(0,limit).map(decode),last=messages.at(-1);
  return pageFor(store,messages,rows.length>limit&&last?Buffer.from(JSON.stringify({sequence:last.sequence,id:last.id})).toString('base64url'):null);
}
export function context(store:Store,messageId:string):Context {
  const target=store.message(messageId);
  const children=listMessages(store,{parent:messageId,limit:50});
  const related=store.db.prepare(`SELECT body FROM messages WHERE id IN (
    SELECT sourceId FROM refs WHERE targetId=? UNION SELECT targetId FROM refs WHERE sourceId=?
  ) ORDER BY sequence DESC,id DESC LIMIT 100`).all(messageId,messageId).map(decode);
  const unique=[...new Map([target,...children.messages,...related].map(m=>[m.id,m])).values()];
  return {...pageFor(store,unique,children.nextCursor),rounds:roundsFor(store,messageId)};
}
export function changes(store:Store,after:number,limit=100) {
  if(!Number.isSafeInteger(after)||after<0)throw new DomainError('变更游标无效');
  const rows=store.db.prepare('SELECT sequence,body FROM changes WHERE sequence>? ORDER BY sequence LIMIT ?').all(after,limit+1);
  const selected=rows.slice(0,limit);
  return {changes:selected.map(r=>JSON.parse(r.body as string)),nextCursor:selected.length?Number(selected.at(-1)!.sequence):after,hasMore:rows.length>limit};
}
