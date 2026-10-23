import {writeFile} from 'node:fs/promises';
import {replayArchive,type Message} from '@gonglun/core';
import {Store} from '../../server/src/db.js';
import {financialFingerprint} from './financial-fingerprint.js';
import {validateRetirementJournal} from './validate-retirement-journal.js';

const stable=(value:unknown)=>JSON.stringify(value,(_key,value)=>value&&typeof value==='object'&&!Array.isArray(value)
  ?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))):value);
if(!process.env.DATABASE_URL)throw new Error('请配置 DATABASE_URL');
const report=await Store.inspect(process.env.DATABASE_URL,{schema:process.env.DATABASE_SCHEMA},async store=>{
  const changes=(await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()).map(row=>JSON.parse(String(row.body)));
  validateRetirementJournal({format:'gonglun-2',changes});
  const replay=replayArchive({format:'gonglun-2',changes});
  const messages=(await store.db.prepare('SELECT body FROM messages ORDER BY id').all()).map(row=>JSON.parse(String(row.body)) as Message);
  const projected=new Map(replay.messages.map(message=>[message.id,message]));
  if(messages.length!==projected.size||messages.some(message=>stable(message)!==stable(projected.get(message.id))))throw new Error('消息与执行记录重放结果不一致');
  const accounts=await store.db.prepare('SELECT * FROM accounts ORDER BY "userId"').all();
  if(accounts.length!==replay.accounts.size||accounts.some(({userId,...account})=>stable(account)!==stable(replay.accounts.get(String(userId)))))throw new Error('账户与账本重放结果不一致');
  const memberships=await store.db.prepare('SELECT "memberId","parentId","sourceId","sourcePartId","bindingId","sourceRevision" FROM memberships ORDER BY "memberId"').all();
  const membership=(row:any)=>[row.memberId,row.parentId,row.sourceId,row.sourcePartId??null,row.bindingId??null,row.sourceRevision??null];
  const actualMemberships=new Map(memberships.map(row=>[String(row.memberId),stable(membership(row))]));
  if(actualMemberships.size!==replay.memberships.length||replay.memberships.some(row=>actualMemberships.get(row.memberId)!==stable(membership(row))))throw new Error('组织归属与执行记录重放结果不一致');
  const indexed=new Map<string,Set<string>>();
  for(const row of await store.db.prepare('SELECT * FROM refs').all()){
    const targets=indexed.get(String(row.sourceId))??new Set<string>();targets.add(String(row.targetId));indexed.set(String(row.sourceId),targets);
  }
  for(const message of messages){
    const targets=new Set(message.parts.flatMap(part=>part.type==='relation'?Object.values(part.roles).flat().map(binding=>binding.reference.messageId)
      :part.type==='display'&&part.target?[part.target.messageId]:[]));
    if(stable([...targets].sort())!==stable([...(indexed.get(message.id)??[])].sort()))throw new Error(`引用索引不一致：${message.id}`);
    if(message.parts.some(part=>part.type==='relation'&&(['unfollow','unblock','legacy-join'].includes(part.relation)
      ||['follow','block'].includes(part.relation)&&!['YES','NO'].includes(part.reason??''))))throw new Error(`仍存在旧格式消息：${message.id}`);
  }
  return {verified:true,messages:messages.length,accounts:accounts.length,memberships:memberships.length,changes:changes.length,sequence:replay.sequence,
    financialFingerprint:await financialFingerprint(store.db),replayMessagesMatch:true,replayAccountsMatch:true,replayMembershipsMatch:true,referenceIndexesMatch:true};
});
if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(report));
