/**
 * mock.ts — In-memory mock API for development and testing.
 *
 * Uses the new extensible TargetRef format:
 *   { kind: 'message', messageId }
 *   { kind: 'text-fragment', messageId, text, hash }
 *   { kind: 'relation', relationId, part? }
 *
 * Includes examples of relation-targeting-relation (recursive relations),
 * new relation types (ANNOTATION, AGREE, DISAGREE, REBUT, ARRANGE),
 * and focus-mode-relevant hop structures.
 */

import type { User, Topic, Message, Relation, PaginatedResponse, TargetRef } from '../types';

const delay = (ms = 150) => new Promise(res => setTimeout(res, ms));

const users: User[] = [
  { id: 'u1', username: 'alice', createdAt: '2024-01-01T00:00:00Z' },
  { id: 'u2', username: 'bob',   createdAt: '2024-01-02T00:00:00Z' },
  { id: 'u3', username: 'charlie', createdAt: '2024-01-03T00:00:00Z' },
];

const topics: Topic[] = [
  {
    id: 't1',
    title: '人工智能是否会取代人类工作？',
    body: '随着AI技术的快速发展，越来越多的工作岗位面临被自动化取代的风险。我们应该如何看待这个问题？',
    status: 'OPEN',
    createdAt: '2024-02-01T10:00:00Z',
    updatedAt: '2024-02-10T15:00:00Z',
    createdBy: users[0],
    _count: { messages: 7 },
  },
  {
    id: 't2',
    title: '远程办公的利与弊',
    body: '疫情之后，远程办公成为新常态。这种工作方式对员工和企业究竟带来了哪些影响？',
    status: 'OPEN',
    createdAt: '2024-02-05T09:00:00Z',
    updatedAt: '2024-02-12T11:00:00Z',
    createdBy: users[1],
    _count: { messages: 3 },
  },
  {
    id: 't3',
    title: '乡村振兴：产业支撑还是文化传承优先？',
    body: '城镇化率已超65%，农村面临人口外流、产业空心化。振兴到底应从何处发力？',
    status: 'ARCHIVED',
    createdAt: '2024-01-15T08:00:00Z',
    updatedAt: '2024-01-30T16:00:00Z',
    createdBy: users[2],
    _count: { messages: 3 },
  },
];

/**
 * t1 tree structure (formed by REPLY/SUPPORT/REBUT/CORRECT):
 *   m1 (root: AI取代论)
 *     └─[REPLY]  m2 (AI创造新职业)
 *         ├─[SUPPORT]  m4 (历史比较论支持m2)
 *         └─[REBUT]    m3 (不平等论反驳m2)
 *             └─[CORRECT] m5 (数据纠正m3)
 *   m6 (root: 政策建议)
 *     └─[REPLY] m7 (追问政策细节)
 *
 * Additional relations (non-tree):
 *   r6: alice ANNOTATION → m2 (注释: "这点值得深入")
 *   r7: bob AGREE → m4 (赞同)
 *   r8: charlie DISAGREE → m1 (反对)
 *   r9: alice ANNOTATION → r1 (对"m2回复m1"这条关系消息本身的注释 — recursive!)
 *   r10: bob ARRANGE → m6 (排列)
 *   r11: charlie REFERENCE → m5 (引用)
 */
const messages: Message[] = [
  {
    id: 'm1', topicId: 't1', contentType: 'TEXT',
    content: 'AI确实在很多领域取代了重复性劳动，比如流水线工人、数据录入员等。这是不可避免的趋势，历史上没有任何技术浪潮能被阻止。',
    createdAt: '2024-02-02T10:00:00Z', createdBy: users[0],
  },
  {
    id: 'm2', topicId: 't1', contentType: 'TEXT',
    content: '但是AI也在创造新的工作机会，比如AI训练师、提示词工程师等新职业正在涌现。净效应未必是负的。',
    createdAt: '2024-02-03T11:00:00Z', createdBy: users[1],
  },
  {
    id: 'm3', topicId: 't1', contentType: 'TEXT',
    content: '新职业集中在高学历群体，AI的发展反而会加剧贫富分化——没有技能的低收入群体将首当其冲被淘汰。',
    createdAt: '2024-02-04T12:00:00Z', createdBy: users[2],
  },
  {
    id: 'm4', topicId: 't1', contentType: 'TEXT',
    content: '历史上每次技术革命都带来了就业结构的变化，但整体就业并未减少。工业革命如此，信息革命如此，AI很可能也是如此。',
    createdAt: '2024-02-05T09:00:00Z', createdBy: users[0],
  },
  {
    id: 'm5', topicId: 't1', contentType: 'TEXT',
    content: '需要纠正一点：根据麦肯锡2023年报告，AI创造的新岗位目前主要集中在大城市和受过高等教育的人群，短期内确实存在结构性失业风险，这与m3的判断部分吻合，但程度没有那么极端。',
    createdAt: '2024-02-06T08:00:00Z', createdBy: users[1],
  },
  {
    id: 'm6', topicId: 't1', contentType: 'TEXT',
    content: '无论结论如何，政策层面应当建立"再培训基金"，对被AI替代的工人提供职业转型支持，这是共识层面最低成本的应对。',
    createdAt: '2024-02-07T10:00:00Z', createdBy: users[2],
  },
  {
    id: 'm7', topicId: 't1', contentType: 'TEXT',
    content: '再培训基金听起来好，但资金从哪里来？对AI企业征收"自动化税"是可行方案吗？',
    createdAt: '2024-02-08T09:00:00Z', createdBy: users[0],
  },
  // t2
  {
    id: 'm8', topicId: 't2', contentType: 'TEXT',
    content: '远程办公让我节省了每天2小时的通勤时间，工作效率反而提高了20%，健康状况也改善了。',
    createdAt: '2024-02-06T10:00:00Z', createdBy: users[1],
  },
  {
    id: 'm9', topicId: 't2', contentType: 'TEXT',
    content: '居家办公的边界感很差，经常出现工作时间延长、无法切换的问题；而且团队协作和创新需要面对面，完全远程会影响凝聚力。',
    createdAt: '2024-02-07T14:00:00Z', createdBy: users[2],
  },
  {
    id: 'm10', topicId: 't2', contentType: 'TEXT',
    content: '混合办公（每周2-3天在家，其余到岗）可以兼顾两者优势，这已经是很多科技公司的共识。',
    createdAt: '2024-02-08T16:00:00Z', createdBy: users[0],
  },
  // t3
  {
    id: 'm11', topicId: 't3', contentType: 'TEXT',
    content: '乡村振兴的关键在于产业振兴，没有产业支撑的振兴只是空谈。文化保护是奢侈品，先解决温饱再谈文化。',
    createdAt: '2024-01-16T10:00:00Z', createdBy: users[1],
  },
  {
    id: 'm12', topicId: 't3', contentType: 'TEXT',
    content: '数字经济为农村发展提供了新机遇，电商直播让农产品直达消费者，这本身就是产业+文化的结合。',
    createdAt: '2024-01-20T11:00:00Z', createdBy: users[2],
  },
  {
    id: 'm13', topicId: 't3', contentType: 'TEXT',
    content: '不能把"先产业后文化"当作对立命题，传统手工艺、民俗旅游本身就是高附加值产业，文化保护就是产业振兴。',
    createdAt: '2024-01-22T09:00:00Z', createdBy: users[0],
  },
];

/**
 * Relations — using new TargetRef format with discriminated unions.
 *
 * r1–r5: tree-forming relations (REPLY, SUPPORT, REBUT, CORRECT)
 * r6–r8: decoration-type relations (ANNOTATION, AGREE, DISAGREE)
 * r9:    RECURSIVE relation — targets relation r1 (relation-as-target fix demo)
 * r10:   ARRANGE (non-tree edge-label)
 * r11:   REFERENCE
 */
const relations: Relation[] = [
  // === Tree-forming relations (t1) ===
  // r1: m2 REPLY → m1
  {
    id: 'r1', topicId: 't1', relationType: 'REPLY',
    sourceMessageId: 'm2',
    targetRefs: [{ kind: 'message', messageId: 'm1' }],
    createdAt: '2024-02-03T11:30:00Z', createdBy: users[1],
  },
  // r2: m4 SUPPORT → m2
  {
    id: 'r2', topicId: 't1', relationType: 'SUPPORT',
    sourceMessageId: 'm4',
    targetRefs: [{ kind: 'message', messageId: 'm2' }],
    createdAt: '2024-02-05T10:00:00Z', createdBy: users[0],
  },
  // r3: m3 REBUT → m2
  {
    id: 'r3', topicId: 't1', relationType: 'REBUT',
    sourceMessageId: 'm3',
    targetRefs: [{ kind: 'message', messageId: 'm2' }],
    createdAt: '2024-02-04T13:00:00Z', createdBy: users[2],
  },
  // r4: m5 CORRECT → m3
  {
    id: 'r4', topicId: 't1', relationType: 'CORRECT',
    sourceMessageId: 'm5',
    targetRefs: [{ kind: 'message', messageId: 'm3' }],
    createdAt: '2024-02-06T09:00:00Z', createdBy: users[1],
  },
  // r5: m7 REPLY → m6
  {
    id: 'r5', topicId: 't1', relationType: 'REPLY',
    sourceMessageId: 'm7',
    targetRefs: [{ kind: 'message', messageId: 'm6' }],
    createdAt: '2024-02-08T09:30:00Z', createdBy: users[0],
  },

  // === Decoration / non-tree relations (t1) ===
  // r6: alice ANNOTATION → fragment of m2 (text-fragment target)
  {
    id: 'r6', topicId: 't1', relationType: 'ANNOTATION',
    sourceMessageId: 'm1',
    targetRefs: [{
      kind: 'text-fragment',
      messageId: 'm2',
      text: 'AI训练师、提示词工程师',
      hash: 'ai-trainer-fragment',
      contextBefore: '比如',
      contextAfter: '等新职业',
    }],
    createdAt: '2024-02-03T14:00:00Z', createdBy: users[0],
  },
  // r7: bob AGREE → m4
  {
    id: 'r7', topicId: 't1', relationType: 'AGREE',
    sourceMessageId: 'm6',
    targetRefs: [{ kind: 'message', messageId: 'm4' }],
    createdAt: '2024-02-07T11:00:00Z', createdBy: users[2],
  },
  // r8: charlie DISAGREE → m1
  {
    id: 'r8', topicId: 't1', relationType: 'DISAGREE',
    sourceMessageId: 'm3',
    targetRefs: [{ kind: 'message', messageId: 'm1' }],
    createdAt: '2024-02-04T15:00:00Z', createdBy: users[2],
  },

  // === RECURSIVE: relation-targeting-relation (t1) ===
  // r9: alice ANNOTATION → r1 (the "m2 REPLY m1" relation message itself)
  //   This demonstrates the KEY BUG FIX: the target is the RELATION MESSAGE r1,
  //   NOT the text messages m1 or m2.
  {
    id: 'r9', topicId: 't1', relationType: 'ANNOTATION',
    sourceMessageId: 'm4',
    targetRefs: [{
      kind: 'relation',
      relationId: 'r1',
      part: 'label',
    }],
    createdAt: '2024-02-05T12:00:00Z', createdBy: users[0],
  },
  // r10: bob ARRANGE → m6
  {
    id: 'r10', topicId: 't1', relationType: 'ARRANGE',
    sourceMessageId: 'm5',
    targetRefs: [{ kind: 'message', messageId: 'm6' }],
    createdAt: '2024-02-06T16:00:00Z', createdBy: users[1],
  },
  // r11: charlie REFERENCE → m5
  {
    id: 'r11', topicId: 't1', relationType: 'REFERENCE',
    sourceMessageId: 'm7',
    targetRefs: [{ kind: 'message', messageId: 'm5' }],
    createdAt: '2024-02-08T10:00:00Z', createdBy: users[0],
  },

  // t2 relations
  {
    id: 'r12', topicId: 't2', relationType: 'REBUT',
    sourceMessageId: 'm9',
    targetRefs: [{ kind: 'message', messageId: 'm8' }],
    createdAt: '2024-02-07T15:00:00Z', createdBy: users[2],
  },
  {
    id: 'r13', topicId: 't2', relationType: 'REPLY',
    sourceMessageId: 'm10',
    targetRefs: [{ kind: 'message', messageId: 'm9' }],
    createdAt: '2024-02-08T17:00:00Z', createdBy: users[0],
  },

  // t3 relations
  {
    id: 'r14', topicId: 't3', relationType: 'REBUT',
    sourceMessageId: 'm12',
    targetRefs: [{ kind: 'message', messageId: 'm11' }],
    createdAt: '2024-01-20T12:00:00Z', createdBy: users[2],
  },
  {
    id: 'r15', topicId: 't3', relationType: 'CORRECT',
    sourceMessageId: 'm13',
    targetRefs: [{ kind: 'message', messageId: 'm11' }],
    createdAt: '2024-01-22T10:00:00Z', createdBy: users[0],
  },
];

let mockToken: string | null = null;
let mockUser: User | null = null;
let nextId = 100;

function genId() { return `mock-${++nextId}`; }

function paginate<T>(arr: T[], page = 1, limit = 20): PaginatedResponse<T> {
  const start = (page - 1) * limit;
  const data = arr.slice(start, start + limit);
  return { data, pagination: { page, limit, total: arr.length, totalPages: Math.ceil(arr.length / limit) } };
}

export async function register(data: { username: string; password: string }) {
  await delay();
  const existing = users.find(u => u.username === data.username);
  if (existing) throw new Error('用户名已存在');
  const user: User = { id: genId(), username: data.username, createdAt: new Date().toISOString() };
  users.push(user);
  return { message: '注册成功', user };
}

export async function login(data: { username: string; password: string }) {
  await delay();
  const user = users.find(u => u.username === data.username);
  if (!user) throw new Error('用户名或密码错误');
  mockToken = `mock-token-${user.id}`;
  mockUser = user;
  return { message: '登录成功', token: mockToken, user };
}

export async function logout() {
  await delay(50);
  mockToken = null;
  mockUser = null;
  return { message: '已退出登录' };
}

export async function getTopics(params?: { query?: string; sort?: string; page?: number; limit?: number }) {
  await delay();
  let filtered = [...topics];
  if (params?.query) {
    const q = params.query.toLowerCase();
    filtered = filtered.filter(t => t.title.toLowerCase().includes(q) || t.body?.toLowerCase().includes(q));
  }
  return paginate(filtered, params?.page, params?.limit);
}

export async function createTopic(data: { title: string; body?: string }) {
  await delay();
  if (!mockUser) throw new Error('请先登录');
  const topic: Topic = {
    id: genId(), title: data.title, body: data.body, status: 'OPEN',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    createdBy: mockUser, _count: { messages: 0 },
  };
  topics.push(topic);
  return topic;
}

export async function getTopic(id: string) {
  await delay();
  const topic = topics.find(t => t.id === id);
  if (!topic) throw new Error('话题不存在');
  return topic;
}

export async function updateTopic(id: string, data: { status: 'OPEN' | 'ARCHIVED' }) {
  await delay();
  const topic = topics.find(t => t.id === id);
  if (!topic) throw new Error('话题不存在');
  topic.status = data.status;
  topic.updatedAt = new Date().toISOString();
  return topic;
}

export async function deleteTopic(id: string) {
  await delay();
  const idx = topics.findIndex(t => t.id === id);
  if (idx === -1) throw new Error('话题不存在');
  topics.splice(idx, 1);
  return { message: '已删除' };
}

export async function getMessages(topicId: string, params?: { page?: number; limit?: number }) {
  await delay();
  const filtered = messages.filter(m => m.topicId === topicId);
  return paginate(filtered, params?.page, params?.limit);
}

export async function createMessage(topicId: string, data: {
  contentType?: 'TEXT' | 'MARKDOWN';
  content: string;
}) {
  await delay();
  if (!mockUser) throw new Error('请先登录');
  const msg: Message = {
    id: genId(), topicId, contentType: data.contentType || 'TEXT',
    content: data.content, createdAt: new Date().toISOString(), createdBy: mockUser,
  };
  messages.push(msg);
  const topic = topics.find(t => t.id === topicId);
  if (topic && topic._count) topic._count.messages++;
  return msg;
}

export async function getRelations(topicId: string, params?: { page?: number; limit?: number }) {
  await delay();
  const filtered = relations.filter(r => r.topicId === topicId);
  return paginate(filtered, params?.page, params?.limit);
}

export async function createRelation(topicId: string, data: {
  relationType: string;
  sourceMessageId?: string | null;
  targetRefs: TargetRef[];
  payload?: import('../types').RelationPayload;
}) {
  await delay();
  if (!mockUser) throw new Error('请先登录');
  const rel: Relation = {
    id: genId(), topicId, relationType: data.relationType,
    sourceMessageId: data.sourceMessageId ?? null, targetRefs: data.targetRefs,
    payload: data.payload,
    createdAt: new Date().toISOString(), createdBy: mockUser,
  };
  relations.push(rel);
  return rel;
}

export async function updateRelation(topicId: string, relationId: string, data: {
  targetRefs: TargetRef[];
}) {
  await delay();
  if (!mockUser) throw new Error('请先登录');
  const idx = relations.findIndex(r => r.id === relationId && r.topicId === topicId);
  if (idx === -1) throw new Error('关系消息不存在');
  relations[idx] = { ...relations[idx], targetRefs: data.targetRefs };
  return relations[idx];
}
