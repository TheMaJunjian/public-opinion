export type ContentKind = 'TEXT' | 'ROUND' | 'ROUND_RESULT' | 'GOVERNANCE' | 'CODE' | 'OPERATIONS';

export type RelationType =
  | 'ANNOTATION'
  | 'REFERENCE'
  | 'REPLY'
  | 'NOTIFY'
  | 'AGREE'
  | 'DISAGREE'
  | 'TAG'
  | 'CORRECT'
  | 'ARRANGE'
  | 'CLASSIFY'
  | 'MERGE'
  | 'SUMMARY'
  | 'RECOMMEND'
  | 'ARCHIVE'
  | 'ATTENTION'
  | 'BLOCK'
  | 'PROPOSAL'
  | 'CODE_CHANGE'
  | 'OPERATIONS'
  | 'JOIN';

export type TargetRef =
  | { kind: 'message'; messageId: string }
  | { kind: 'text-fragment'; messageId: string; text: string; hash: string }
  | { kind: 'relation'; relationId: string; part?: 'label' | 'decoration' | 'frame' | 'whole' };

export interface Author {
  id: string;
  username: string;
}

interface MessageBase {
  id: string;
  topicId: string;
  createdAt: string;
  createdBy: Author;
  content: string | null;
  supersededBy?: string | null;
}

export interface ContentMessage extends MessageBase {
  kind: ContentKind;
  contentType: 'TEXT' | 'MARKDOWN' | null;
  quoteSourceId?: string | null;
  targetRefs?: TargetRef[];
  relationType?: RelationType | null;
  relationPayload?: RelationPayload | null;
}

export interface RelationPayload {
  label?: string;
  title?: string;
  content?: string;
  targetLayout?: 'single-column' | 'multi-column' | 'single-row';
  subType?: 'SPAM' | 'OFFTOPIC' | 'LOWVALUE' | 'IMPORTANT' | 'CUSTOM';
  customLabel?: string;
  note?: string;
  amount?: number;
  vote?: boolean;
  roundId?: string;
  settlementType?: 'TRUTH' | 'VALUE';
}

export interface RelationMessage extends MessageBase {
  kind: 'RELATION';
  relationType: RelationType;
  sourceMessageId: string | null;
  targetRefs: TargetRef[];
  relationPayload: RelationPayload | null;
}

export type TopicMessage = ContentMessage | RelationMessage;

export interface TopicIndex {
  byId: Map<string, TopicMessage>;
  relationById: Map<string, RelationMessage>;
  relationsBySourceId: Map<string, RelationMessage[]>;
  relationsByTargetId: Map<string, RelationMessage[]>;
}

export function createTopicIndex(messages: TopicMessage[]): TopicIndex {
  const byId = new Map<string, TopicMessage>();
  const relationById = new Map<string, RelationMessage>();
  const relationsBySourceId = new Map<string, RelationMessage[]>();
  const relationsByTargetId = new Map<string, RelationMessage[]>();

  for (const message of messages) {
    byId.set(message.id, message);
    if (message.kind !== 'RELATION') continue;
    relationById.set(message.id, message);
    if (message.sourceMessageId) addToIndex(relationsBySourceId, message.sourceMessageId, message);
    for (const target of message.targetRefs) {
      const targetId = target.kind === 'relation' ? target.relationId : target.messageId;
      addToIndex(relationsByTargetId, targetId, message);
    }
  }

  return { byId, relationById, relationsBySourceId, relationsByTargetId };
}

function addToIndex(index: Map<string, RelationMessage[]>, key: string, relation: RelationMessage) {
  const relations = index.get(key) ?? [];
  relations.push(relation);
  index.set(key, relations);
}

export function relationTargetId(target: TargetRef): string {
  return target.kind === 'relation' ? target.relationId : target.messageId;
}

export function targetLabel(target: TargetRef, index: TopicIndex): string {
  const message = index.byId.get(relationTargetId(target));
  const shortId = relationTargetId(target).slice(-6);
  if (target.kind === 'text-fragment') return `片段「${target.text.slice(0, 26)}${target.text.length > 26 ? '...' : ''}」`;
  if (message?.kind === 'RELATION') return `${relationLabel(message.relationType)} ${shortId}`;
  return message?.content?.slice(0, 34) || `消息 ${shortId}`;
}

export function relationLabel(type: RelationType): string {
  const labels: Record<RelationType, string> = {
    ANNOTATION: '注释', REFERENCE: '引用', REPLY: '回复', NOTIFY: '通知',
    AGREE: '赞同', DISAGREE: '反对', TAG: '标注', CORRECT: '更正',
    ARRANGE: '排列', CLASSIFY: '分类', MERGE: '归并', SUMMARY: '总结',
    RECOMMEND: '推荐', ARCHIVE: '冷藏', ATTENTION: '关注', BLOCK: '拉黑',
    PROPOSAL: '提案', CODE_CHANGE: '代码变更', OPERATIONS: '运营', JOIN: '加入容器',
  };
  return labels[type];
}

export function isContentMessage(message: TopicMessage): message is ContentMessage {
  return message.kind !== 'RELATION';
}
