import {replayArchive,type Change,type Membership} from '@gonglun/core';
import type {MigrationChange} from './migration-types.js';
/** Validate the previous retirement journal before the standalone importer normalizes it. */
export function validateRetirementJournal(archive:{format:string;changes:Change[]}):void {
  for(let index=0;index<archive.changes.length;index++) {
    const change=archive.changes[index] as MigrationChange;
    if(!change.upgrade)continue;
    const before=replayArchive({...archive,journal:undefined,changes:archive.changes.slice(0,index)});
    const messages=new Map(before.messages.map(message=>[message.id,message]));
    const memberships=new Map(before.memberships.map(row=>[row.memberId,row]));
    const retiredTopics=new Set(before.states.filter(state=>state.organizationRetired).map(state=>state.messageId));
    const operating=before.operating,issued=before.issued;
    if (change.upgrade !== undefined) {
      const upgrade = change.upgrade;
      const invalid = () => { throw new Error('旧 Topic 取消升级记录不一致'); };
      if (!upgrade || upgrade.kind !== 'retire-legacy-topics' || upgrade.version !== 1
        || !Array.isArray(upgrade.topicIds) || !upgrade.topicIds.length || new Set(upgrade.topicIds).size !== upgrade.topicIds.length
        || !Array.isArray(upgrade.releasedMemberships) || !Array.isArray(upgrade.retiredJoinIds)
        || change.messages.length || change.ledger.length || change.memberships.length
        || change.treasury?.operating !== operating || change.treasury?.issued !== issued) invalid();
      const ids = new Set(upgrade.topicIds);
      for (const id of ids) {
        const topic = messages.get(id);
        if (retiredTopics.has(id) || !topic?.parts.some(part => part.type === 'relation' && part.relation === 'classify')
          || !topic.parts.some(part => part.type === 'data' && part.value && typeof part.value === 'object' && !Array.isArray(part.value)
            && (part.value.legacyTopicId === id || (part.value.origin as any)?.kind==='topic-classification' && (part.value.origin as any)?.id===id) && part.value.uiType === 'CLASSIFY')) invalid();
        const state = change.states.find(state => state.messageId === id);
        if (!state?.organizationRetired || !state.suppressed) invalid();
      }
      const expected = [...memberships.values()].filter(row => ids.has(row.parentId) || ids.has(row.memberId));
      const membershipKey = (row: Membership) => JSON.stringify([row.memberId, row.parentId, row.sourceId, row.sourcePartId ?? null, row.bindingId ?? null, row.sourceRevision ?? null]);
      const equal = (a: string[], b: string[]) => JSON.stringify(a.sort()) === JSON.stringify(b.sort());
      if (!equal(expected.map(membershipKey), upgrade.releasedMemberships.map(membershipKey))
        || !equal(expected.map(row => row.memberId), [...change.removedMemberships])) invalid();
      const joins = [...messages.values()].filter(message => message.parts.some(part => {
        if (part.type !== 'relation') return false;
        const hasTopic = (role: string) => part.roles[role]?.some(binding => ids.has(binding.reference.messageId));
        return part.relation === 'member-of' && part.roles.member?.length && (hasTopic('parent') || hasTopic('member'))
          || part.relation === 'legacy-join' && hasTopic('source');
      })).map(message => message.id);
      if (!equal(joins, [...upgrade.retiredJoinIds]) || joins.some(id => !change.states.find(state => state.messageId === id)?.membershipDisabled)) invalid();
      ids.forEach(id => retiredTopics.add(id));
    }

  }
}
