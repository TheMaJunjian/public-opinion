import {bindRoles,relations,type Change,type Json,type Membership,type MembershipAction,type Message,type Part} from '@gonglun/core';
import {Mutation,type Store} from '../../server/src/db.js';
import {reconcileOrganizationEffects,setMembership} from '../../server/src/organizations.js';
import {statesFor} from '../../server/src/projections.js';

async function createBaselineJoin(tx:Mutation,origin:Message,memberId:string,parentId:string) {
  const parts:Part[]=[{id:'relation',type:'relation',relation:'member-of',roles:bindRoles({parent:[{messageId:parentId}],member:[{messageId:memberId}]})},
    {id:'data',type:'data',value:{uiType:'JOIN',generatedBy:origin.id}}];
  const message=await tx.create(origin.authorId,parts);
  message.createdAt=origin.createdAt;message.updatedAt=origin.updatedAt;
  message.sequence=origin.sequence;
  await tx.store.db.prepare('UPDATE messages SET "createdAt"=$1 WHERE id=$2').run(message.createdAt,message.id);
  await tx.put(message);
  return message;
}
/** Upgrade older native placements using the committed change log as their history. */
export async function initializeOrganizationMemberships(store: Store) {
    const rows = await store.db.prepare(`SELECT m.*,s.body FROM memberships m JOIN messages s ON s.id=m."sourceId"
        WHERE NOT EXISTS (SELECT 1 FROM membership_actions a WHERE a.body->>'memberId'=m."memberId") ORDER BY m.position`).all();
    const native = rows;
    if (!native.length) return;
    const timelines = new Map<string, Array<Membership | null>>(native.map(row => [String(row.memberId), []]));
    for (const row of await store.db.prepare('SELECT body FROM changes ORDER BY sequence').all()) {
        const change = JSON.parse(String(row.body));
        for (const memberId of change.removedMemberships) timelines.get(memberId)?.push(null);
        for (const membership of change.memberships) timelines.get(membership.memberId)?.push(membership);
    }
    // Previous imports stored only the final placement in the journal. Preserve
    // every earlier JOIN as an explicit predecessor before publishing native history.
    const declarations=(await store.db.prepare('SELECT body FROM messages ORDER BY "createdAt",id').all()).map(row=>JSON.parse(String(row.body)) as Message);
    for(const [memberId,timeline] of timelines){
      const missing:Membership[]=[];
      for(const message of declarations)for(const part of relations(message)){
        if(part.relation!=='member-of'||!part.roles.member?.some(binding=>binding.reference.messageId===memberId))continue;
        const parentId=part.roles.parent?.[0]?.reference.messageId;
        if(parentId&&!timeline.some(entry=>entry?.sourceId===message.id))missing.push({memberId,parentId,sourceId:message.id,sourcePartId:part.id,sourceRevision:message.revision});
      }
      timeline.unshift(...missing);
    }
    const tx = new Mutation(store);
    for (const row of native) {
        const memberId = String(row.memberId), timeline = timelines.get(memberId)!;
        const last = timeline.at(-1);
        if (last?.parentId !== row.parentId || last?.sourceId !== row.sourceId) timeline.push(row as unknown as Membership);
        let previousId: string | null = null, previousParentId: string | null = null;
        for (const entry of timeline) {
            if (!entry) { previousId = null; previousParentId = null; continue; }
            const origin = await store.message(entry.sourceId);
            const explicit = relations(origin).find(part => part.relation === 'member-of' && part.roles.member?.length === 1 && part.roles.member[0]?.reference.messageId === memberId);
            const join = explicit ? origin : await createBaselineJoin(tx, origin, memberId, entry.parentId);
            let actionRow = await store.db.prepare('SELECT body,position FROM membership_actions WHERE id=$1').get(join.id);
            if (explicit && actionRow) { previousId = join.id; previousParentId = entry.parentId; continue; }
            if (!actionRow) actionRow = await store.db.prepare('INSERT INTO membership_actions(id,body) VALUES ($1,$2) RETURNING position').get(join.id, '{}');
            const history: MembershipAction = { id: join.id, memberId, parentId: entry.parentId, previousId, previousParentId, order: Number(actionRow!.position) };
            await store.db.prepare('UPDATE membership_actions SET body=$1 WHERE id=$2').run(JSON.stringify(history), join.id);
            join.parts = [...join.parts.filter(part => part.id !== 'membership-history'), { id: 'membership-history', type: 'data', value: { membershipHistory: history as unknown as Json } }];
            await tx.put(join);
            previousId = join.id; previousParentId = entry.parentId;
        }
        if (previousId) await setMembership(tx, { memberId, parentId: String(row.parentId), sourceId: previousId, sourcePartId: 'relation', bindingId: 'member-0', sourceRevision: 1 });
    }
    await reconcileOrganizationEffects(tx);
    // Materializing history is not a new personal choice. Keep every source's
    // original chronology while publishing the added native records once.
    const previousSequence=await store.latestSequence();
    const sequence=Number((await store.db.prepare("INSERT INTO changes(body) VALUES('{}') RETURNING sequence").get())!.sequence);
    const change:Change={sequence,previousSequence,messages:[...tx.messages.values()],memberships:[...tx.memberships.values()],removedMemberships:[...tx.removed],
      states:await statesFor(store,[...tx.affected]),ledger:[],treasury:{operating:await store.setting('operating'),issued:await store.setting('minted')}};
    await store.db.prepare('UPDATE changes SET body=$1 WHERE sequence=$2').run(JSON.stringify(change),sequence);
}
