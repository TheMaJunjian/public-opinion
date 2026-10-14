import { type HomeFilterMode } from "../../../components/HomeFilterPanel";
import type { User } from "../../../types";
import type {
  DemoEdge,
  DemoMessage
} from "../../../utils/modelBridge";
import { isContentKind } from "../../../utils/modelBridge";
import { type TraceContainerMembership } from "../../../utils/traceProjection";
import { buildHomeFilterDisplayIds, deriveHomeContentMatchSetsBySender, partitionHomeContentMatchIds } from '../model/filters';

interface DeriveHomeFilterResultInput {
  displayUser: User | null;
  homeFilterMode: HomeFilterMode | null;
  msgMap: Map<string, DemoMessage>;
  messages: DemoMessage[];
  readStatusByMessageId: Map<string, "READ" | "UNREAD">;
  edges: DemoEdge[];
  traceContainerMemberships: TraceContainerMembership[];
}

export function deriveHomeFilterResult(input: DeriveHomeFilterResultInput): { matchIds: Set<string>; displayIds: Set<string>; } | null {
  const { displayUser, homeFilterMode, msgMap, messages, readStatusByMessageId, edges, traceContainerMemberships } = input;
  const currentUsername = displayUser?.username;
  if (homeFilterMode === null) return null;
  const allMessageIds = new Set(msgMap.keys());
  const contentIds = new Set(
    messages.filter(message => isContentKind(message.kind)).map(message => message.id),
  );
  const readContentIds = new Set(
    [...readStatusByMessageId]
      .filter(([id, status]) => status === 'READ' && contentIds.has(id))
      .map(([id]) => id)
      .filter(id => allMessageIds.has(id)),
  );
  const unreadContentIds = new Set(
    [...readStatusByMessageId]
      .filter(([id, status]) => status === 'UNREAD' && contentIds.has(id))
      .map(([id]) => id)
      .filter(id => allMessageIds.has(id)),
  );
  const { selfContentIds, readRelatedContentIds, unreadRelatedContentIds } = deriveHomeContentMatchSetsBySender({
    messages,
    edges,
    contentIds,
    currentUsername,
  });
  const {
    readSelfMatchIds,
    readRelatedMatchIds,
    unreadRelatedMatchIds,
    unreadOtherMatchIds,
  } = partitionHomeContentMatchIds({
    contentIds,
    selfContentIds,
    unreadRelatedContentIds,
    readRelatedContentIds,
    readContentIds,
    unreadContentIds,
  });

  const matchIds = homeFilterMode === 'read-self'
    ? readSelfMatchIds
    : homeFilterMode === 'read-related'
      ? readRelatedMatchIds
      : homeFilterMode === 'unread-other'
        ? unreadOtherMatchIds
        : unreadRelatedMatchIds;
  const excludedContentContextIds = homeFilterMode === 'unread-related'
    ? undefined
    : new Set([
      ...readSelfMatchIds,
      ...readRelatedMatchIds,
    ]);
  const displayIds = buildHomeFilterDisplayIds(matchIds, edges, {
    includeRelationContext: homeFilterMode === 'unread-related' || homeFilterMode === 'unread-other',
    excludedContentContextIds,
    containerMemberships: traceContainerMemberships,
  });
  return { matchIds, displayIds };
}
