import type { Relation, User } from '../types';
import type { DemoEdge, DemoMessage } from './modelBridge';

export function isTextMessage(message: DemoMessage): boolean {
  return message.kind === 'normal' && !message.relationType;
}

export function isRelationMessage(message: DemoMessage): boolean {
  return !isTextMessage(message);
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function dataParts(message: DemoMessage): Record<string, unknown>[] {
  return (message.parts ?? []).flatMap(part => {
    const value = part.type === 'data' ? record(part.value) : undefined;
    return value ? [value] : [];
  });
}

function addUnique(map: Map<string, Set<string>>, targetId: string, sourceId: string) {
  const sources = map.get(targetId) ?? new Set<string>();
  sources.add(sourceId);
  map.set(targetId, sources);
}

/** Share one scope and one metric definition between the user and message leaderboards. */
export function buildLeaderboardMetrics(messages: DemoMessage[], edges: DemoEdge[], relations: Relation[], users: User[]) {
  const rankedMessages = [...new Map(messages.map(message => [message.id, message])).values()];
  const messageById = new Map(rankedMessages.map(message => [message.id, message]));
  const rankedIds = new Set(rankedMessages.map(message => message.id));
  const incomingReferences = new Map<string, Set<string>>();
  const outgoingReferences = new Map<string, Set<string>>();
  const settlements = new Map<string, Set<string>>();
  const roundTargets = new Map(messages.filter(message => message.kind === 'round' && message.settlementTargetId)
    .map(message => [String(message.roundPayload?.roundId ?? message.id), message.settlementTargetId!]));
  const stanceStakes = new Map<string, number>();
  const rechargeIncome = new Map<string, number>();
  const idToName = new Map(users.map(user => [user.id, user.username]));
  for (const relation of relations) idToName.set(relation.createdBy.id, relation.createdBy.username);
  for (const message of rankedMessages) if (message.authorId) idToName.set(message.authorId, message.author);
  const sendAuthors = new Map(rankedMessages.map(message => [message.id, message.author]));
  const roundMessages = new Map(rankedMessages.filter(message => message.kind === 'round')
    .map(message => [String(message.roundPayload?.roundId ?? message.id), message]));
  const roundActor = (message: DemoMessage): string | undefined => {
    if (message.authorId !== 'system') return message.author;
    const basis = dataParts(message).find(value => typeof value.openedBy === 'string') ?? message.roundPayload;
    if (typeof basis?.openedBy === 'string') return idToName.get(basis.openedBy);
    const trigger = typeof basis?.triggerId === 'string' ? messageById.get(basis.triggerId) : undefined;
    return trigger && trigger.authorId !== 'system' ? trigger.author : undefined;
  };
  for (const message of rankedMessages) {
    if (message.authorId !== 'system') continue;
    let actor: string | undefined;
    if (message.kind === 'round') actor = roundActor(message);
    if (message.kind === 'round_result') {
      const distribution = dataParts(message).find(value => value.source === 'wager');
      const inputs = record(distribution?.inputs);
      const trigger = typeof inputs?.triggerId === 'string' ? messageById.get(inputs.triggerId) : undefined;
      // A delayed settlement uses its subject as a technical trigger; use the round's initiator instead.
      if (trigger && trigger.authorId !== 'system' && trigger.id !== message.settlementTargetId) actor = trigger.author;
      const round = typeof inputs?.roundId === 'string' ? roundMessages.get(inputs.roundId) : undefined;
      if (!actor && round) actor = roundActor(round);
    }
    if (actor) sendAuthors.set(message.id, actor);
  }

  for (const edge of edges) {
    if (edge.relationType !== 'reference') continue;
    if (rankedIds.has(edge.to.messageId)) addUnique(incomingReferences, edge.to.messageId, edge.relationMessageId);
    if (rankedIds.has(edge.from.messageId)) addUnique(outgoingReferences, edge.from.messageId, edge.relationMessageId);
  }

  const rechargeProposals = new Set(relations.filter(relation =>
    relation.payload?.operationType === 'RECHARGE'
    || relation.parts?.some(part => part.type === 'relation' && part.relation === 'recharge')
  ).map(relation => relation.id));

  for (const message of messages) {
    const payload = message.roundPayload;
    const data = dataParts(message);
    const distribution = data.find(value => typeof value.source === 'string' && Array.isArray(value.allocations));
    // Income comes from executed allocations, never from a pending recharge proposal.
    if (distribution?.source === 'grant') {
      const inputs = record(distribution.inputs);
      if (typeof inputs?.proposalId === 'string' && rechargeProposals.has(inputs.proposalId)) {
        for (const allocation of distribution.allocations as unknown[]) {
          const entry = record(allocation);
          if (typeof entry?.userId !== 'string') continue;
          const name = idToName.get(entry.userId) ?? entry.userId;
          rechargeIncome.set(name, (rechargeIncome.get(name) ?? 0) + finiteNumber(entry.amount));
        }
      }
    }
    if (message.kind !== 'round' && message.kind !== 'round_result') continue;
    if (distribution && distribution.source !== 'wager') continue;
    const inputs = record(distribution?.inputs);
    const roundId = inputs?.roundId ?? payload?.roundId ?? message.id;
    const target = roundTargets.get(String(roundId)) ?? message.settlementTargetId;
    if (!target || !rankedIds.has(target)) continue;
    addUnique(settlements, target, String(roundId));
  }

  for (const relation of new Map(relations.map(relation => [relation.id, relation])).values()) {
    if (!['AGREE', 'DISAGREE'].includes(relation.relationType.toUpperCase())) continue;
    const amount = finiteNumber(relation.spending?.wager ?? relation.payload?.amount);
    if (amount <= 0) continue;
    // Native execution may resolve a stance on another stance to its actual wager target.
    const targets = relation.executedStance ? [relation.executedStance.target.messageId]
      : relation.targetRefs.map(ref => ref.reference?.messageId ?? (ref.kind === 'relation' ? ref.relationId : ref.messageId));
    for (const target of new Set(targets)) {
      if (rankedIds.has(target)) stanceStakes.set(target, (stanceStakes.get(target) ?? 0) + amount);
    }
  }

  return { rankedMessages, sendAuthors, incomingReferences, outgoingReferences, settlements, stanceStakes, rechargeIncome, idToName };
}
