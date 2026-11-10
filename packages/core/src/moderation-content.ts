import type { Message, Part } from './types.js';

type RelationPart = Extract<Part, { type: 'relation' }>;

const aliases: Record<string, string[]> = {
  'member-of': ['JOIN'], 'legacy-join': ['JOIN'],
  follow: ['ATTENTION', 'UNFOLLOW'], block: ['BLOCK', 'UNBLOCK'],
  correct: ['CORRECT'], amend: ['CORRECT'],
  recommend: ['RECOMMEND', 'AGREE'], archive: ['ARCHIVE', 'DISAGREE'], 'low-quality': ['ARCHIVE', 'DISAGREE'],
  delegate: ['DELEGATION'], fulfill: ['DELEGATION'],
  'rule-change': ['PROPOSAL'], recharge: ['PROPOSAL', 'OPERATIONS'], 'revenue-injection': ['PROPOSAL', 'OPERATIONS'],
  distribute: ['PROPOSAL', 'OPERATIONS'], terminate: ['PROPOSAL', 'OPERATIONS'],
};
const fixedLabels: Record<string, ReadonlySet<string>> = {
  reference: new Set(['evidence', '证据', 'delegation', '完成委托', 'reference', 'ref', '引用']),
  reply: new Set(['question', '疑问', 'answer', '回答', 'reply', '回复']),
};
const reasonLabels: Record<string, string> = { SPAM: '垃圾', OFFTOPIC: '跑题', LOWVALUE: '低质', IMPORTANT: '重要', YES: '是', NO: '否' };
const normalized = (value: string) => value.replace(/\s+/gu, '');

/** Match the complete old generated description against the actual relation and
 * endpoint IDs. A prefix match or a user-supplied display type is not enough. */
function generatedDescriptions(actions: RelationPart[]): Set<string> {
  const descriptions = new Set<string>();
  for (const action of actions) {
    const types = aliases[action.relation] ?? [action.relation.toUpperCase().replaceAll('-', '_')];
    const bindings = action.roles.target ?? action.roles.members ?? action.roles.member ?? [];
    const ids = bindings.map(binding => binding.reference.messageId);
    for (const type of types) {
      descriptions.add(`建立关系：${type}`);
      for (const targets of [ids, [...new Set(ids)]].flatMap(ids => [ids, ids.map(id => id.slice(-8))])) for (const separator of [',', '、']) {
        if (targets.length) descriptions.add(normalized(`建立关系：${type}；目标：${targets.join(separator)}`));
      }
    }
  }
  return descriptions;
}

/** Review authored content, not automatic action descriptions or built-in choices. */
export function hasModeratedContent(message: Pick<Message, 'parts'>, actions: RelationPart[], data: Record<string, unknown>): boolean {
  if ([data.content, data.title, data.customLabel].some(value => typeof value === 'string' && !!value.trim())) return true;
  const generated = generatedDescriptions(actions);
  // Annotation votes retain the original addressed annotation even after their
  // executable target is normalized to that annotation's subject.
  const stance = data.annotationStance as { side?: unknown; target?: { messageId?: unknown } } | undefined;
  if (actions.length === 1 && ['tag', 'recommend', 'archive', 'low-quality', 'follow', 'block'].includes(actions[0]!.relation)
    && stance && ['pro', 'con'].includes(String(stance.side)) && typeof stance.target?.messageId === 'string') {
    for (const description of generatedDescriptions([{ id: 'original-stance', type: 'relation', relation: stance.side === 'pro' ? 'agree' : 'disagree',
      roles: { target: [{ id: 'target', reference: { messageId: stance.target.messageId } }] } }])) generated.add(description);
  }
  const label = typeof data.label === 'string' ? data.label.trim() : '';
  if (label) {
    if (actions.length !== 1 || !fixedLabels[actions[0]!.relation]?.has(label.toLowerCase())) return true;
    generated.add(normalized(label));
  }
  if (actions.length && actions.every(action => ['recommend', 'archive', 'low-quality', 'follow', 'block', 'attention'].includes(action.relation))) {
    const subtype = typeof data.subType === 'string' ? data.subType : '';
    if (reasonLabels[subtype]) {
      generated.add(subtype);
      generated.add(reasonLabels[subtype]!);
    }
  }
  return message.parts.some(part => part.type === 'code' || part.type === 'web'
    || part.type === 'text' && !!part.text.trim() && (part.id !== 'body' || !generated.has(normalized(part.text))));
}
