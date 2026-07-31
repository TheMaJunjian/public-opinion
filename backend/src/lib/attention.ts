import { prisma } from './prisma';

type AttentionRelation = {
  createdById: string;
  targetRefs: unknown;
  relationPayload: unknown;
};

function targetMessageIds(targetRefs: unknown): string[] {
  if (!Array.isArray(targetRefs)) return [];
  return targetRefs.flatMap(ref => {
    if (!ref || typeof ref !== 'object') return [];
    const value = ref as { kind?: string; messageId?: unknown };
    return (value.kind === 'message' || value.kind === 'text-fragment') && typeof value.messageId === 'string'
      ? [value.messageId]
      : [];
  });
}

/** Returns active attention users grouped by each target message ID. */
export async function getAttentionUsersByTargetIds(
  topicId: string,
  targetIds?: Iterable<string>,
): Promise<Map<string, Set<string>>> {
  const requestedIds = targetIds ? new Set(targetIds) : null;
  const relations = await prisma.message.findMany({
    where: { topicId, kind: 'RELATION', relationType: 'TAG', supersededBy: null },
    select: { createdById: true, targetRefs: true, relationPayload: true },
  }) as AttentionRelation[];
  const result = new Map<string, Set<string>>();
  for (const relation of relations) {
    const payload = relation.relationPayload;
    if (!payload || typeof payload !== 'object' || (payload as { subType?: unknown }).subType !== 'ATTENTION') continue;
    const ids = targetMessageIds(relation.targetRefs);
    for (const id of ids) {
      if (requestedIds && !requestedIds.has(id)) continue;
      const users = result.get(id) ?? new Set<string>();
      users.add(relation.createdById);
      result.set(id, users);
    }
  }
  return result;
}

export function attentionUsersToJson(attentionUsers: Map<string, Set<string>>): Record<string, string[]> {
  return Object.fromEntries([...attentionUsers].map(([messageId, users]) => [messageId, [...users]]));
}
