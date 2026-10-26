import {relations,targetInvestmentDimension,type Message} from '@gonglun/core';
import {Mutation,type Store} from '../../server/src/db.js';
import {repairValueVoteMessages} from './repair-value-vote-messages.js';

/** A preserved value-claim address can expose an old stance only after its minimum principal is reassigned. */
export async function normalizeTargetValueFields(store:Store){
  await repairValueVoteMessages(store);
  const repairs=new Map<string,Message>();
  for(const row of await store.db.prepare('SELECT body FROM messages').all()){
    const message=JSON.parse(String(row.body)) as Message;
    if(!message.spending.wager||message.spending.recommendation||!relations(message).some(part=>targetInvestmentDimension(part.relation)==='VALUE')
      ||relations(message).some(part=>['agree','disagree'].includes(part.relation)&&part.roles.target?.[0]?.reference.messageId===message.id))continue;
    const positions=await store.db.prepare('SELECT b.amount,r.body::jsonb->>\'settlementType\' AS type FROM bets b JOIN rounds r ON r.id=b."roundId" WHERE b."messageId"=$1').all(message.id);
    if(!positions.length||positions.some(row=>row.type!=='VALUE')||positions.reduce((sum,row)=>sum+Number(row.amount),0)!==message.spending.wager)continue;
    repairs.set(`${message.id}:${message.revision}`,{...message,spending:{...message.spending,wager:0,recommendation:message.spending.wager}});
  }
  if(!repairs.size)return 0;
  await store.db.exec('CREATE TABLE IF NOT EXISTS target_value_field_backups(table_name TEXT NOT NULL,row_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(table_name,row_key))');
  const transform=(input:any):any=>{
    if(Array.isArray(input))return input.map(transform);
    if(!input||typeof input!=='object')return input;
    const repair=typeof input.id==='string'&&Array.isArray(input.parts)?repairs.get(`${input.id}:${input.revision}`):undefined;
    if(repair)return {...input,spending:repair.spending};
    return Object.fromEntries(Object.entries(input).map(([key,value])=>[key,['input','sourceAudit'].includes(key)?value:transform(value)]));
  };
  for(const table of [{name:'requests',key:'jsonb_build_array("userId","requestId")::text'},{name:'command_requests',key:'jsonb_build_array("userId","requestId")::text'}])
    for(const row of await store.db.prepare(`SELECT ${table.key} row_key,result FROM ${table.name}`).all()){
      const before=JSON.parse(String(row.result)),after=transform(before);if(JSON.stringify(before)===JSON.stringify(after))continue;
      await store.db.prepare('INSERT INTO target_value_field_backups VALUES($1,$2,$3) ON CONFLICT DO NOTHING').run(table.name,row.row_key,row.result);
      await store.db.prepare(`UPDATE ${table.name} SET result=$1 WHERE ${table.key}=$2`).run(JSON.stringify(after),row.row_key);
    }
  const tx=new Mutation(store);
  for(const message of repairs.values()){
    await store.db.prepare('INSERT INTO target_value_field_backups VALUES($1,$2,$3) ON CONFLICT DO NOTHING').run('messages',message.id,JSON.stringify(await store.message(message.id)));
    await tx.put(message);
  }
  await tx.commit();return repairs.size;
}
