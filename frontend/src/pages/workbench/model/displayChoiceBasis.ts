import type { deriveDisplayHints, DisplayHintsInput } from './displayHints';
import { isContainerType } from './containerEffect';

export type DisplayChoiceBasisEntry = { id: string; label: string };
type HintData = Pick<ReturnType<typeof deriveDisplayHints>, 'hints' | 'recommendedEffect' | 'personalStances' | 'stanceEffects'>;

/** Explain the existing winners and stance records; never infer an opposition. */
export function displayChoiceBasis(input: DisplayHintsInput, data: HintData, messageId: string) {
  const personal = new Map<string, string>(), recommended = new Map<string, string>();
  const messages = input.personalEffect.msgMap;
  const add = (group: Map<string, string>, id: string | undefined, label: string) => {
    if (id && messages.has(id) && !group.has(id)) group.set(id, label);
  };
  const decision = (id: string) => {
    const source = input.personalEffect.choiceSourcesByMessage?.get(id);
    const stance = source ? { relMsgId: source.messageId, type: source.type } : data.personalStances.get(id), message = messages.get(id);
    const differs = data.hints.get(id)?.personalActive !== data.hints.get(id)?.recommendedActive;
    if (stance && (message?.kind !== 'join' || stance.type === 'disagree' || input.personalEffect.effectiveJoinIds.has(id)))
      add(personal, stance.relMsgId, source?.creation ? '创建时的选择' : stance.type === 'agree' ? '赞同消息' : '反对消息');
    else if (!stance && differs && message?.author === input.username
      && (isContainerType(message.relationType) || message.kind === 'join' && input.personalEffect.effectiveJoinIds.has(id)))
      add(personal, id, '创建时的选择');
  };
  const membership = (targetId: string) => {
    const chosen = input.personalEffect.joinByTarget.get(targetId), proposed = data.recommendedEffect.joinByTarget.get(targetId);
    if (chosen === proposed) return;
    add(personal, chosen, '当前采用的加入记录');
    add(recommended, proposed, '推荐采用的加入记录');
    for (const id of [chosen, proposed]) if (id) {
      decision(id);
      const parent = input.personalEffect.relationById.get(id)?.sourceMessageId;
      if (parent && data.hints.get(parent)?.personalActive !== data.hints.get(parent)?.recommendedActive) decision(parent);
    }
  };
  const visited = new Set<string>();
  const collect = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const message = messages.get(id);
    if (!message) return;
    const hint = data.hints.get(id);
    if (hint?.personalActive !== hint?.recommendedActive) decision(id);
    if (message.kind === 'join') {
      for (const target of message.joinInfo?.targetIds ?? []) membership(target);
      const parent = message.joinInfo?.containerId;
      if (parent && data.hints.get(parent)?.personalActive !== data.hints.get(parent)?.recommendedActive) decision(parent);
    } else membership(id);
    if (isContainerType(message.relationType)) for (const member of new Set([...(hint?.personal.memberIds ?? []), ...(hint?.recommended.memberIds ?? [])])) membership(member);
    const bodyId = message.relationType === 'correct'
      ? input.edges.find(edge => edge.relationType === 'correct' && edge.relationMessageId === id)?.to.messageId : id;
    const body = bodyId ? data.hints.get(bodyId) : undefined;
    for (const correction of body?.personal.correctionIds ?? []) if (!body?.recommended.correctionIds.includes(correction)) {
      add(personal, correction, '当前采用的更正'); decision(correction);
    }
    for (const correction of body?.recommended.correctionIds ?? []) if (!body?.personal.correctionIds.includes(correction)) {
      add(recommended, correction, '推荐采用的更正'); decision(correction);
    }
    const targets = data.stanceEffects.get(id);
    if (targets?.length) for (const target of targets) collect(target.targetId);
    else if (!recommended.size) add(recommended, id, '公共统计对应的消息');
  };
  collect(messageId);
  const entries = (group: Map<string, string>): DisplayChoiceBasisEntry[] => [...group].map(([id, label]) => ({ id, label }));
  return { personal: entries(personal), recommended: entries(recommended) };
}
