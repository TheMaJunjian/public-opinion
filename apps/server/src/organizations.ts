import { ORGANIZATIONS, relations, type Membership, type Message } from '@gonglun/core';
import { DomainError, Mutation } from './db.js';

function parent(tx:Mutation,memberId:string):string|null {
  const row=tx.store.db.prepare('SELECT parentId FROM memberships WHERE memberId=?').get(memberId);return row?String(row.parentId):null;
}
function move(tx:Mutation,memberId:string,parentId:string,sourceId:string,sourcePartId:string,bindingId:string,sourceRevision:number) {
  if(memberId===parentId)throw new DomainError('消息不能包含自身');
  const previousParent=parent(tx,memberId);
  const organization=tx.store.message(parentId);
  if(!relations(organization).some(p=>ORGANIZATIONS.has(p.relation)||p.relation==='members'))throw new DomainError('父消息必须是组织');
  let current:string|null=parentId;
  const seen=new Set<string>();
  while(current){if(current===memberId||seen.has(current))throw new DomainError('组织不能形成循环');seen.add(current);current=parent(tx,current);if(seen.size>1000)throw new DomainError('组织层级过深');}
  const membership:Membership={memberId,parentId,sourceId,sourcePartId,bindingId,sourceRevision};
  tx.store.db.prepare('INSERT INTO memberships VALUES (?,?,?,?,?,?) ON CONFLICT(memberId) DO UPDATE SET parentId=excluded.parentId,sourceId=excluded.sourceId,sourcePartId=excluded.sourcePartId,bindingId=excluded.bindingId,sourceRevision=excluded.sourceRevision').run(memberId,parentId,sourceId,sourcePartId,bindingId,sourceRevision);
  tx.memberships.set(memberId,membership);tx.removed.delete(memberId);
  tx.affected.add(parentId);if(previousParent)tx.affected.add(previousParent);
  // Moving an organization also changes the scoped visibility of every descendant.
  for(const row of tx.store.db.prepare('WITH RECURSIVE subtree(id) AS (SELECT ? UNION SELECT m.memberId FROM memberships m JOIN subtree s ON m.parentId=s.id) SELECT id FROM subtree').all(memberId))tx.affected.add(String(row.id));
}
export function applyOrganization(tx:Mutation,message:Message) {
  for(const part of relations(message)) {
    if(ORGANIZATIONS.has(part.relation)||part.relation==='members') {
      const bindings=part.roles.members??[],members=bindings.map(b=>b.reference);
      if(members.some(ref=>ref.partId||ref.memberId||ref.path?.length||ref.range||ref.revision!==undefined))throw new DomainError('组织成员须指向当前完整消息');
      if(new Set(members.map(ref=>ref.messageId)).size!==members.length)throw new DomainError('组织成员不能重复');
      if(members.length) {
        const parents=new Set(members.map(ref=>parent(tx,ref.messageId)));
        if(parents.size!==1)throw new DomainError('重新组织的消息须为同父兄弟');
        const existingParent=[...parents][0];
        if(existingParent)move(tx,message.id,existingParent,message.id,part.id,'inherited-parent',message.revision);
        for(const binding of bindings)move(tx,binding.reference.messageId,message.id,message.id,part.id,binding.id,message.revision);
      }
    }
    if(part.relation==='member-of') {
      if(part.roles.parent?.length!==1)throw new DomainError('加入组织须指定唯一父消息');
      const members=part.roles.member??[{id:'self',reference:{messageId:message.id}}];
      if(members.length!==1)throw new DomainError('加入组织须指定唯一成员');
      move(tx,members[0]!.reference.messageId,part.roles.parent[0]!.reference.messageId,message.id,part.id,members[0]!.id,message.revision);
    }
  }
}
