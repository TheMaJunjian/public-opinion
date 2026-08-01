import type { TopicMessage } from './messages';
import type { TopicSnapshot } from './topicSnapshot';

const author = (id: string, username: string) => ({ id, username });
const at = (seconds: number) => new Date(Date.UTC(2026, 7, 1, 8, 0, seconds)).toISOString();

export const fixtureTopic = {
  id: 'demo-topic',
  title: '人工智能是否应承担公共决策责任？',
  body: '重构演示：关系消息是独立对象，而不是附着在两个消息之间的边。',
};

export const fixtureMessages: TopicMessage[] = [
  {
    id: 'msg-claim', topicId: fixtureTopic.id, kind: 'TEXT', contentType: 'TEXT',
    content: '公共机构可以使用人工智能辅助决策，但最终责任必须由可追责的人承担。',
    createdAt: at(0), createdBy: author('u-lin', '林岚'),
  },
  {
    id: 'msg-evidence', topicId: fixtureTopic.id, kind: 'TEXT', contentType: 'TEXT',
    content: '算法可以提高一致性，却无法自行解释价值冲突，因此需要把模型依据和人工裁量一并公开。',
    createdAt: at(20), createdBy: author('u-qiao', '乔野'),
  },
  {
    id: 'msg-counter', topicId: fixtureTopic.id, kind: 'TEXT', contentType: 'TEXT',
    content: '在低风险、高重复的行政流程中，人工复核可以是抽检，而非每次都参与。',
    createdAt: at(40), createdBy: author('u-su', '苏言'),
  },
  {
    id: 'rel-reply', topicId: fixtureTopic.id, kind: 'RELATION', relationType: 'REPLY',
    sourceMessageId: 'msg-evidence', targetRefs: [{ kind: 'message', messageId: 'msg-claim' }],
    relationPayload: { label: '补充理由' }, content: '回复：补充公开依据的理由。',
    createdAt: at(25), createdBy: author('u-qiao', '乔野'),
  },
  {
    id: 'rel-reference', topicId: fixtureTopic.id, kind: 'RELATION', relationType: 'REFERENCE',
    sourceMessageId: 'msg-evidence', targetRefs: [{ kind: 'text-fragment', messageId: 'msg-claim', text: '最终责任必须由可追责的人承担', hash: 'claim-responsibility' }],
    relationPayload: { label: '责任归属' }, content: '引用：责任要求。',
    createdAt: at(27), createdBy: author('u-qiao', '乔野'),
  },
  {
    id: 'rel-annotation', topicId: fixtureTopic.id, kind: 'RELATION', relationType: 'ANNOTATION',
    sourceMessageId: 'msg-counter', targetRefs: [{ kind: 'text-fragment', messageId: 'msg-evidence', text: '价值冲突', hash: 'value-conflict' }],
    relationPayload: { content: '这里需要区分事实判断与价值判断。' }, content: '注释：价值冲突。',
    createdAt: at(45), createdBy: author('u-su', '苏言'),
  },
  {
    id: 'rel-agree', topicId: fixtureTopic.id, kind: 'RELATION', relationType: 'AGREE',
    sourceMessageId: null, targetRefs: [{ kind: 'relation', relationId: 'rel-reply', part: 'whole' }],
    relationPayload: { amount: 20, settlementType: 'TRUTH' }, content: '赞同：补充理由。',
    createdAt: at(50), createdBy: author('u-mei', '梅青'),
  },
  {
    id: 'rel-disagree', topicId: fixtureTopic.id, kind: 'RELATION', relationType: 'DISAGREE',
    sourceMessageId: 'msg-counter', targetRefs: [{ kind: 'message', messageId: 'msg-claim' }],
    relationPayload: { amount: 12, settlementType: 'TRUTH' }, content: '反对：需要人工逐案参与。',
    createdAt: at(55), createdBy: author('u-su', '苏言'),
  },
  {
    id: 'rel-recommend', topicId: fixtureTopic.id, kind: 'RELATION', relationType: 'RECOMMEND',
    sourceMessageId: null, targetRefs: [{ kind: 'message', messageId: 'msg-evidence' }],
    relationPayload: { subType: 'IMPORTANT', amount: 15, settlementType: 'VALUE' }, content: '推荐：重要论据。',
    createdAt: at(60), createdBy: author('u-mei', '梅青'),
  },
  {
    id: 'rel-classify', topicId: fixtureTopic.id, kind: 'RELATION', relationType: 'CLASSIFY',
    sourceMessageId: null, targetRefs: [{ kind: 'message', messageId: 'msg-claim' }, { kind: 'relation', relationId: 'rel-reply' }],
    relationPayload: { title: '责任与可解释性' }, content: '分类：责任与可解释性。',
    createdAt: at(65), createdBy: author('u-lin', '林岚'),
  },
  {
    id: 'rel-summary', topicId: fixtureTopic.id, kind: 'RELATION', relationType: 'SUMMARY',
    sourceMessageId: null, targetRefs: [{ kind: 'message', messageId: 'msg-claim' }, { kind: 'message', messageId: 'msg-evidence' }],
    relationPayload: { content: '自动化可以扩大判断能力，但责任、理由与争议入口必须保留在人类共同体中。' }, content: '总结。',
    createdAt: at(70), createdBy: author('u-lin', '林岚'),
  },
  {
    id: 'rel-join', topicId: fixtureTopic.id, kind: 'RELATION', relationType: 'JOIN',
    sourceMessageId: 'rel-classify', targetRefs: [{ kind: 'message', messageId: 'msg-claim' }],
    relationPayload: null, content: '加入容器。', createdAt: at(72), createdBy: author('u-lin', '林岚'),
  },
];

export const fixtureSnapshot: TopicSnapshot = {
  formatVersion: 1,
  topic: {
    ...fixtureTopic,
    body: fixtureTopic.body,
    status: 'OPEN',
  },
  messages: fixtureMessages,
};
