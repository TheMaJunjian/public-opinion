import {bodyVersion,relations,organization,type SendInput} from '@gonglun/core';
import type {Store} from './db.js';
import {DomainError} from './db.js';

/** New commands bind their address once. Historical conversion is migration-only. */
export async function bindCommandContexts(store:Store,input:SendInput):Promise<SendInput>{
  const next=structuredClone(input);
  const roundId=next.parts.flatMap(part=>part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value)&&typeof part.value.roundId==='string'?[part.value.roundId]:[])[0];
  if(roundId&&!await store.db.prepare('SELECT 1 FROM rounds WHERE id=$1').get(roundId))throw new DomainError('指定结算轮次不存在');
  for(const part of next.parts){
    if(part.type!=='relation')continue;
    for(const [role,bindings] of Object.entries(part.roles))for(const binding of bindings){
      const ref=binding.reference;
      if(roundId&&role==='target'&&['agree','disagree','recommend','archive','tag'].includes(part.relation))continue;
      if(part.relation==='terminate'){
        if(roundId){
          const selected=await store.db.prepare('SELECT body FROM rounds WHERE id=$1').get(roundId);
          binding.reference=JSON.parse(String(selected!.body)).target;continue;
        }
        const rounds=await store.db.prepare("SELECT body FROM rounds WHERE body::jsonb #>> '{target,messageId}'=$1 AND body::jsonb #>> '{status}'<>'settled'").all(ref.messageId);
        if(rounds.length!==1)throw new DomainError('请选择明确的结算轮次');
        binding.reference=JSON.parse(String(rounds[0]!.body)).target;continue;
      }
      if(['correct','amend','member-of','classify','summary','merge','arrange','authorize','settlement','distribution','terminate'].includes(part.relation))continue;
      const viewed=ref.context&&'version' in ref.context?ref.context.version:undefined;
      const target=await store.message(ref.messageId,ref.revision??viewed?.revision),whole=!ref.partId&&!ref.path?.length&&!ref.memberId&&!ref.range;
      const targetRelations=relations(target);
      if(part.relation==='open-settlement'&&ref.partId&&targetRelations.some(p=>p.id===ref.partId&&p.relation==='open-value-settlement'))continue;
      const stancePart=targetRelations.find(p=>['agree','disagree'].includes(p.relation)&&p.roles.target?.[0]?.reference.messageId!==target.id);
      if(['agree','disagree'].includes(part.relation)&&stancePart&&!ref.range&&!ref.memberId&&(!ref.partId||ref.partId===stancePart.id)&&(!ref.path?.length||ref.path.length===1&&ref.path[0]==='relation')){ref.revision=target.revision;delete ref.context;continue;}
      if(['follow','block'].includes(part.relation)||whole&&(organization(target)||targetRelations.some(p=>p.relation==='member-of'&&p.roles.member?.length))){ref.context={kind:'MESSAGE'};continue;}
      const correction=targetRelations.find(part=>part.relation==='correct');
      if(correction&&(whole||ref.partId===correction.id)){ref.context={kind:'MESSAGE'};continue;}
      if(ref.context?.kind==='UNKNOWN')throw new DomainError('请选择明确的消息引用');
      ref.revision=target.revision;
      ref.context={kind:'MESSAGE',...(viewed||!whole?{version:viewed??bodyVersion(target.id,target.revision)}:{})};
    }
  }
  for(const part of next.parts)if(part.type==='relation')for(const bindings of Object.values(part.roles))for(const {reference} of bindings){
    if(reference.context?.kind==='UNKNOWN')throw new DomainError('历史语境未知，请选择明确的正文版本');
  }
  return next;
}
