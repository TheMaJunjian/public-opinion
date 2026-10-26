import {ORGANIZATIONS,replaceReference,type Message,type Part,type RelationPart} from '@gonglun/core';
import type {DemoMessage} from '../../../utils/modelBridge';

const organizationParts=(parts:Part[])=>parts.filter((part):part is RelationPart=>part.type==='relation'&&(ORGANIZATIONS.has(part.relation)||part.relation==='member-of'||part.relation==='members'));
const data=(message:DemoMessage)=>Object.assign({},...(message.parts??[]).filter(part=>part.type==='data').map(part=>part.value&&typeof part.value==='object'&&!Array.isArray(part.value)?part.value:{}));

/** Authorizing a structural edit can publish placement messages as well as the authorization. */
export function authorizationJoinCount(targetIds:string[],messages:ReadonlyMap<string,DemoMessage>,parents:ReadonlyMap<string,string>):number{
  let count=0;
  const currentParents=new Map(parents);
  for(const id of targetIds){
    const proposal=messages.get(id),amendment=proposal?.parts?.find((part):part is RelationPart=>part.type==='relation'&&part.relation==='amend');
    const target=amendment?.roles.target?.[0]?.reference,original=target&&messages.get(target.messageId);
    if(!proposal||!target||!original?.parts)continue;
    let next:Part[];
    try{const value=data(proposal);next=replaceReference(original as unknown as Message,target,value.parts??value.value);}catch{continue;}
    const before=organizationParts(original.parts),after=organizationParts(next);
    if(JSON.stringify(before)===JSON.stringify(after))continue;
    const oldGroup=before.find(part=>ORGANIZATIONS.has(part.relation)),newGroup=after.find(part=>ORGANIZATIONS.has(part.relation));
    if(before.some(part=>part.relation==='member-of'&&part.roles.member?.length)){
      const placement=after.find(part=>part.relation==='member-of'&&part.roles.member?.length);
      if(placement){count++;currentParents.set(placement.roles.member![0]!.reference.messageId,placement.roles.parent![0]!.reference.messageId);}
    }else if(oldGroup&&newGroup){
      const desired=new Set((newGroup.roles.members??[]).map(binding=>binding.reference.messageId));
      const existing=[...currentParents].filter(([,parent])=>parent===original.id).map(([member])=>member),outer=currentParents.get(original.id);
      for(const member of existing)if(!desired.has(member)){if(outer){count++;currentParents.set(member,outer);}else currentParents.delete(member);}
      for(const member of desired)if(!existing.includes(member)){count++;currentParents.set(member,original.id);}
    }else if(!oldGroup){
      for(const part of after){
        if(ORGANIZATIONS.has(part.relation)||part.relation==='members'){
          const members=(part.roles.members??[]).map(binding=>binding.reference.messageId),parent=currentParents.get(members[0]??'');
          if(members.length&&parent&&members.every(member=>currentParents.get(member)===parent)){count++;currentParents.set(original.id,parent);}
          for(const member of members){count++;currentParents.set(member,original.id);}
        }else if(part.relation==='member-of'&&!part.roles.member?.length){count++;currentParents.set(original.id,part.roles.parent![0]!.reference.messageId);}
      }
    }
  }
  return count;
}
