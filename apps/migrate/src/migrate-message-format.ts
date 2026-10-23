import {relations,replaceReference,textOf,type Message,type Part} from '@gonglun/core';
import type {Store} from '../../server/src/db.js';
import {presentationMigration,upgradePresentationParts} from './presentation-format.js';

/** Previous formats are interpreted only here; the application receives native parts. */
export async function migrateMessageFormat(store:Store):Promise<void>{
  const originals=new Map((await store.db.prepare('SELECT body FROM revisions').all()).map(row=>{
    const message=JSON.parse(String(row.body)) as Message;return [`${message.id}:${message.revision}`,message] as const;
  }));
  const latest=new Map((await store.db.prepare('SELECT body FROM messages').all()).map(row=>{const message=JSON.parse(String(row.body)) as Message;return [message.id,message] as const;}));
  const presentation= presentationMigration([...latest.values()]);
  function transform(input:any):any{
    if(Array.isArray(input))return input.map(transform);
    if(!input||typeof input!=='object')return input;
    if(typeof input.id!=='string'||!Array.isArray(input.parts))return Object.fromEntries(Object.entries(input).map(([key,value])=>[key,key==='input'?value:transform(value)]));
    const message=structuredClone(input) as Message;
    message.parts=upgradePresentationParts(message,presentation);
    const meta=message.parts.find(part=>part.type==='data');
    if(meta?.type!=='data'||!meta.value||typeof meta.value!=='object'||Array.isArray(meta.value))return {...input,parts:message.parts};
    const data=meta.value,imported=typeof data.legacyTopicId==='string',relation=relations(message).find(part=>part.relation!=='member-of'||part.roles.member?.length);
    if(imported&&relation){
      if(data.legacyTopicId===message.id&&data.uiType==='CLASSIFY')data.origin={kind:'topic-classification',id:message.id};
      if(relation.relation==='legacy-join'){
        relation.relation='member-of';relation.roles={parent:relation.roles.source??[],member:relation.roles.target??[]};
      }
      if(data.uiType==='CORRECT'&&relation.relation==='amend')relation.relation='correct';
      if(data.kind==='RELATION'&&!['classify','summary','correct'].includes(relation.relation)&&!message.parts.some(part=>part.type==='display'))
        message.parts.push({id:'presentation',type:'display',relationPartId:relation.id,layout:'relation'});
      if(data.legacySupersededBy)data.supersededBy=data.legacySupersededBy;
    }
    const textCorrection=data.uiType==='CORRECT'&&(data.correctionKind==='TEXT'||typeof data.correctionContent==='string'||data.correctionValue!==undefined);
    if(relation&&(relation.relation==='correct'||relation.relation==='amend'&&(imported||textCorrection))){
      const target=relation.roles.target?.[0]?.reference;
      const original=target&&(target.revision?originals.get(`${target.messageId}:${target.revision}`):latest.get(target.messageId));
      let replacement=data.value??data.correctionAfterContent??data.correctionContent;
      if(imported&&target?.range&&original&&data.value===undefined&&typeof replacement==='string'){
        const before=textOf(original),prefix=before.slice(0,target.range.start),suffix=before.slice(target.range.end);
        if(!replacement.startsWith(prefix)||!replacement.endsWith(suffix))throw new Error(`更正 ${message.id} 的全文与原选区不一致，迁移已回滚`);
        replacement=replacement.slice(prefix.length,replacement.length-suffix.length);
      }
      if(original&&target?.partId&&typeof replacement==='string'){
        try{
          const before=textOf(original),after=textOf({...original,parts:replaceReference(original,target,replacement)});
          relation.relation='correct';data.value=replacement;data.correctionBeforeContent=before;
          if(!message.parts.some(part=>part.id==='corrected-body'))message.parts.unshift({id:'corrected-body',type:'text',text:after});
          data.correctionKind??='TEXT';
        }catch{/* Non-text proposals retain their explicit native amendment parts. */}
      }
    }
    if(relation&&['classify','summary','merge','arrange'].includes(relation.relation)&&!message.parts.some(part=>part.id==='organization-memberships'))
      message.parts.push({id:'organization-memberships',type:'data',value:{independentMemberships:true}});
    for(const key of Object.keys(data))if(key.startsWith('legacy'))delete data[key];
    return {...input,parts:message.parts};
  }
  const tables=[{name:'messages',column:'body',key:'id'},{name:'revisions',column:'body',key:'jsonb_build_array("messageId",revision)::text'},
    {name:'changes',column:'body',key:'sequence::text'},{name:'requests',column:'result',key:'jsonb_build_array("userId","requestId")::text'},
    {name:'command_requests',column:'result',key:'jsonb_build_array("userId","requestId")::text'}];
  await store.db.exec('CREATE TABLE IF NOT EXISTS message_format_backups(table_name TEXT NOT NULL,row_key TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(table_name,row_key))');
  for(const table of tables)for(const row of await store.db.prepare(`SELECT ${table.key} AS row_key,${table.column} AS body FROM ${table.name}`).all()){
    const old=JSON.parse(String(row.body)),upgraded=transform(old);
    if(JSON.stringify(old)===JSON.stringify(upgraded))continue;
    await store.db.prepare('INSERT INTO message_format_backups VALUES($1,$2,$3) ON CONFLICT DO NOTHING').run(table.name,row.row_key,row.body);
    await store.db.prepare(`UPDATE ${table.name} SET ${table.column}=$1 WHERE ${table.key}=$2`).run(JSON.stringify(upgraded),row.row_key);
    if(table.name==='messages'){
      await store.db.prepare('DELETE FROM refs WHERE "sourceId"=$1').run(upgraded.id);
      const targets=new Set<string>(upgraded.parts.flatMap((part:Part)=>part.type==='relation'?Object.values(part.roles).flat().map(binding=>binding.reference.messageId)
        :part.type==='display'&&part.target?[part.target.messageId]:[]));
      for(const target of targets)await store.db.prepare('INSERT INTO refs VALUES($1,$2) ON CONFLICT DO NOTHING').run(upgraded.id,target);
    }
  }
}
