import type { ExportData } from '../api/client';
import type { WorkbenchSnapshot } from '../data/workbench';
import type { Message, Relation } from '../types';
import { convertMessagesToDemoModel } from './modelBridge';

/** Online snapshots and archive viewing must derive exactly the same display data. */
export function projectWorkbenchSnapshot(snapshot: WorkbenchSnapshot) {
  const active = snapshot.messages.filter(message => !message.supersededBy);
  const activeIds = new Set(active.map(message => message.id));
  const relations = snapshot.relations.filter(relation => activeIds.has(relation.id));
  const converted = convertMessagesToDemoModel(active, relations);
  const counts: Record<string, { truth: { pro: number; con: number }; value: { pro: number; con: number } }> = {};
  const authorAmounts: Record<string, number> = {};
  const bettors: Record<string, number> = {};
  const byId = new Map(converted.messages.map(message => [message.id, message]));
  for (const [id, stakes] of Object.entries(snapshot.stakes)) {
    counts[id] = { truth: stakes.countsByType?.TRUTH ?? stakes.counts, value: stakes.countsByType?.VALUE ?? { pro: 0, con: 0 } };
    authorAmounts[id] = stakes.stakes.filter(stake => stake.side === 'PRO' && stake.user.username === byId.get(id)?.author).reduce((sum, stake) => sum + stake.amount, 0);
    bettors[id] = new Set(stakes.stakes.map(stake => stake.user.id)).size;
  }
  return { ...converted, relations, counts, authorAmounts, bettors };
}

export function archiveToWorkbenchSnapshot(data: ExportData): WorkbenchSnapshot {
  const messages = data.messages.map(message => ({ ...message,
    createdBy: { id: message.authorId, username: message.author, createdAt: '' },
  })) as Message[];
  const relations: Relation[] = data.relations.map(relation => ({ ...relation,
    relationType: relation.relationType ?? 'REFERENCE', targetRefs: (relation.targetRefs ?? []) as Relation['targetRefs'],
    payload: (relation.payload ?? undefined) as Relation['payload'],
    createdBy: { id: relation.authorId, username: relation.author, createdAt: '' },
  }));
  const attentionUsers: WorkbenchSnapshot['attentionUsers'] = {};
  for (const relation of [...relations].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))) {
    if (relation.relationType.toUpperCase() !== 'ATTENTION') continue;
    for (const ref of relation.targetRefs) {
      if (ref.kind !== 'message' && ref.kind !== 'text-fragment') continue;
      const users = attentionUsers[ref.messageId] ?? [];
      if(relation.payload?.subType==='NO'){
        attentionUsers[ref.messageId]=users.filter(id=>id!==relation.createdBy.id);continue;
      }
      if (!users.includes(relation.createdBy.id)) users.push(relation.createdBy.id);
      attentionUsers[ref.messageId] = users;
    }
  }
  return { scope: data.scope, messages, relations, users: data.users ?? [], sequence: 0,
    stakes: data.stakes ?? {}, tagCounts: data.tagCounts ?? {}, attentionUsers: data.attentionUsers ?? attentionUsers };
}
