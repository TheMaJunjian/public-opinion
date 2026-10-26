import type { Relation } from '../../../types';
import { getPresentationSpec } from '../../../types';
import type { DemoEdge, DemoMessage } from '../../../utils/modelBridge';

export const READ_STATUS_RELATION_TYPES = new Set(['read', 'unread']);

export function getLatestUserReadStatusByMessageId(
  relations: Pick<Relation, 'relationType' | 'createdAt' | 'createdBy' | 'targetRefs' | 'sequence'>[],
  isCurrentUser: (relation: Pick<Relation, 'createdBy'>) => boolean,
): Map<string, 'READ' | 'UNREAD'> {
  const latest = new Map<string, { type: 'READ' | 'UNREAD'; createdAt: string; sequence?: number }>();
  for (const relation of relations) {
    const type = relation.relationType?.toUpperCase();
    if ((type !== 'READ' && type !== 'UNREAD') || !isCurrentUser(relation)) continue;
    for (const target of relation.targetRefs) {
      const targetId = target.kind === 'relation' ? target.relationId : target.messageId;
      const previous = latest.get(targetId);
      if (!previous || (relation.sequence && previous.sequence
        ? relation.sequence > previous.sequence
        : new Date(relation.createdAt).getTime() >= new Date(previous.createdAt).getTime())) {
        latest.set(targetId, { type, createdAt: relation.createdAt, sequence: relation.sequence });
      }
    }
  }
  return new Map([...latest].map(([id, value]) => [id, value.type]));
}

export function partitionHomeFilterMatchIds(params: {
  allMessageIds: ReadonlySet<string>;
  selfCardMessageIds: ReadonlySet<string>;
  selfRelatedMessageIds: ReadonlySet<string>;
  readRelatedIds: ReadonlySet<string>;
  readMarkedTargets: ReadonlySet<string>;
  unreadMarkedTargets: ReadonlySet<string>;
  unreadRelatedIds: ReadonlySet<string>;
  statusAnnotationIds: ReadonlySet<string>;
}): {
  readSelfMatchIds: Set<string>;
  readRelatedMatchIds: Set<string>;
  unreadRelatedMatchIds: Set<string>;
  unreadOtherMatchIds: Set<string>;
} {
  const unreadRelatedMatchIds = new Set(
    [...params.unreadRelatedIds].filter(id => params.allMessageIds.has(id) && !params.statusAnnotationIds.has(id)),
  );
  const readRelatedMatchIds = new Set(
    [...new Set([...params.selfRelatedMessageIds, ...params.readMarkedTargets, ...params.readRelatedIds])].filter(id =>
      params.allMessageIds.has(id) &&
      !params.statusAnnotationIds.has(id) &&
      !params.selfCardMessageIds.has(id) &&
      !unreadRelatedMatchIds.has(id),
    ),
  );
  const readSelfMatchIds = new Set(
    [...params.selfCardMessageIds].filter(id =>
      !params.unreadMarkedTargets.has(id) &&
      !unreadRelatedMatchIds.has(id) &&
      !params.statusAnnotationIds.has(id),
    ),
  );
  const claimedMatchIds = new Set([
    ...readSelfMatchIds,
    ...readRelatedMatchIds,
    ...unreadRelatedMatchIds,
    ...params.statusAnnotationIds,
  ]);
  const unreadOtherMatchIds = new Set(
    [...params.allMessageIds].filter(id => !claimedMatchIds.has(id)),
  );
  return { readSelfMatchIds, readRelatedMatchIds, unreadRelatedMatchIds, unreadOtherMatchIds };
}

export function partitionHomeContentMatchIds(params: {
  contentIds: ReadonlySet<string>;
  selfContentIds: ReadonlySet<string>;
  unreadRelatedContentIds: ReadonlySet<string>;
  readRelatedContentIds: ReadonlySet<string>;
  readContentIds: ReadonlySet<string>;
  unreadContentIds: ReadonlySet<string>;
}): {
  readSelfMatchIds: Set<string>;
  readRelatedMatchIds: Set<string>;
  unreadRelatedMatchIds: Set<string>;
  unreadOtherMatchIds: Set<string>;
} {
  const readSelfMatchIds = new Set(
    [...params.selfContentIds].filter(id =>
      params.contentIds.has(id)
      && !params.unreadContentIds.has(id),
    ),
  );
  const unreadRelatedMatchIds = new Set(
    [...params.unreadRelatedContentIds].filter(id =>
      params.contentIds.has(id)
      && !readSelfMatchIds.has(id)
      && !params.readContentIds.has(id),
    ),
  );
  const readRelatedMatchIds = new Set(
    [...new Set([...params.readRelatedContentIds, ...params.readContentIds])].filter(id =>
      params.contentIds.has(id)
      && !readSelfMatchIds.has(id)
      && !params.unreadContentIds.has(id),
    ),
  );
  const claimedIds = new Set([
    ...readSelfMatchIds,
    ...unreadRelatedMatchIds,
    ...readRelatedMatchIds,
  ]);
  const unreadOtherMatchIds = new Set(
    [...params.contentIds].filter(id => !claimedIds.has(id)),
  );
  return { readSelfMatchIds, readRelatedMatchIds, unreadRelatedMatchIds, unreadOtherMatchIds };
}

export function deriveHomeContentMatchSetsBySender(params: {
  messages: Pick<DemoMessage, 'id' | 'author' | 'kind' | 'relationType'>[];
  edges: Pick<DemoEdge, 'relationMessageId' | 'from' | 'to'>[];
  contentIds: ReadonlySet<string>;
  currentUsername: string | undefined;
}): {
  selfContentIds: Set<string>;
  readRelatedContentIds: Set<string>;
  unreadRelatedContentIds: Set<string>;
} {
  const messageById = new Map(params.messages.map(message => [message.id, message]));
  const selfContentIds = new Set(
    params.messages
      .filter(message => message.author === params.currentUsername && params.contentIds.has(message.id))
      .map(message => message.id),
  );
  const selfRelationIds = new Set(
    params.messages
      .filter(message => message.author === params.currentUsername && message.kind === 'relation')
      .filter(message => !['read', 'unread'].includes(message.relationType?.toLowerCase() ?? ''))
      .map(message => message.id),
  );
  const readRelatedContentIds = new Set<string>();
  const unreadRelatedContentIds = new Set<string>();

  for (const edge of params.edges) {
    const relation = messageById.get(edge.relationMessageId);
    const endpointIds = [edge.from.messageId, edge.to.messageId];
    const contentEndpointIds = endpointIds.filter(id => params.contentIds.has(id));
    if (selfRelationIds.has(edge.relationMessageId)) {
      contentEndpointIds.forEach(id => readRelatedContentIds.add(id));
      continue;
    }
    if (!relation || relation.author === params.currentUsername) continue;
    if (params.contentIds.has(edge.relationMessageId)
      && (selfContentIds.has(edge.to.messageId) || selfContentIds.has(edge.from.messageId))) {
      unreadRelatedContentIds.add(edge.relationMessageId);
    }
    if (selfContentIds.has(edge.from.messageId) && params.contentIds.has(edge.to.messageId)) {
      unreadRelatedContentIds.add(edge.to.messageId);
    }
    if (selfContentIds.has(edge.to.messageId) && params.contentIds.has(edge.from.messageId)) {
      unreadRelatedContentIds.add(edge.from.messageId);
    }
  }

  return { selfContentIds, readRelatedContentIds, unreadRelatedContentIds };
}

export function buildHomeFilterDisplayIds(
  matchIds: ReadonlySet<string>,
  edges: Pick<DemoEdge, 'relationMessageId' | 'relationType' | 'from' | 'to'>[],
  options: {
    includeRelationContext?: boolean;
    excludedContentContextIds?: ReadonlySet<string>;
    containerMemberships?: ReadonlyArray<{
      containerId: string;
      targetIds: readonly string[];
    }>;
  } = {},
): Set<string> {
  const displayIds = new Set(matchIds);
  for (const edge of edges) {
    const correctionMatch = edge.relationType === 'correct' && matchIds.has(edge.relationMessageId);
    if (!matchIds.has(edge.from.messageId) && !matchIds.has(edge.to.messageId)
      && !correctionMatch && !(options.includeRelationContext && matchIds.has(edge.relationMessageId))) continue;
    if (READ_STATUS_RELATION_TYPES.has(edge.relationType.toLowerCase())) continue;
    const isContainer = getPresentationSpec(edge.relationType).isContainer;
    if (!isContainer && !options.includeRelationContext && !correctionMatch) continue;
    displayIds.add(edge.relationMessageId);
    if (!isContainer) {
      for (const endpointId of [edge.from.messageId, edge.to.messageId]) {
        if (!endpointId.startsWith('anon:')
          && (correctionMatch || !options.excludedContentContextIds?.has(endpointId))) {
          displayIds.add(endpointId);
        }
      }
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of edges) {
      if (getPresentationSpec(edge.relationType).isContainer
        && displayIds.has(edge.to.messageId)
        && !displayIds.has(edge.relationMessageId)) {
        displayIds.add(edge.relationMessageId);
        changed = true;
      }
    }
    for (const membership of options.containerMemberships ?? []) {
      if (membership.targetIds.some(targetId => displayIds.has(targetId))
        && !displayIds.has(membership.containerId)) {
        displayIds.add(membership.containerId);
        changed = true;
      }
    }
  }
  return displayIds;
}

export function filterUnreadRelatedTraceMatchIds(params: {
  traceDistanceMessageIds: ReadonlySet<string>;
  selfMessageIds: ReadonlySet<string>;
  readMarkedTargets: ReadonlySet<string>;
  statusAnnotationIds: ReadonlySet<string>;
}): Set<string> {
  return new Set(
    [...params.traceDistanceMessageIds].filter(id =>
      !params.selfMessageIds.has(id)
      && !params.readMarkedTargets.has(id)
      && !params.statusAnnotationIds.has(id),
    ),
  );
}
