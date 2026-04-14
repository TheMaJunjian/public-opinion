import type { User, Topic, Message, Relation, PaginatedResponse, TargetRef } from '../types';

const delay = (ms = 150) => new Promise(res => setTimeout(res, ms));

const users: User[] = [
  { id: 'u1', username: 'alice', createdAt: '2024-01-01T00:00:00Z' },
  { id: 'u2', username: 'bob', createdAt: '2024-01-02T00:00:00Z' },
  { id: 'u3', username: 'charlie', createdAt: '2024-01-03T00:00:00Z' },
];

/**
 * 示例话题：体现公论"永恒、递归、迭代、追溯、求是的会议"特性
 */
const topics: Topic[] = [
  {
    id: 't1',
    title: '人工智能是否会取代人类工作？',
    body: '随着AI技术的快速发展，越来越多的工作岗位面临被自动化取代的风险。我们应该如何看待这个问题？',
    status: 'OPEN',
    createdAt: '2024-02-01T10:00:00Z',
    updatedAt: '2024-02-10T15:00:00Z',
    createdBy: users[0],
    _count: { messages: 7, relations: 7 },
  },
  {
    id: 't2',
    title: '远程办公的利与弊',
    body: '疫情之后，远程办公成为新常态。这种工作方式对员工和企业究竟带来了哪些影响？',
    status: 'OPEN',
    createdAt: '2024-02-05T09:00:00Z',
    updatedAt: '2024-02-12T11:00:00Z',
    createdBy: users[1],
    _count: { messages: 3, relations: 3 },
  },
  {
    id: 't3',
    title: '乡村振兴：产业支撑还是文化传承优先？',
    body: '城镇化率已超65%，农村面临人口外流、产业空心化。振兴到底应从何处发力？',
    status: 'ARCHIVED',
    createdAt: '2024-01-15T08:00:00Z',
    updatedAt: '2024-01-30T16:00:00Z',
    createdBy: users[2],
    _count: { messages: 3, relations: 2 },
  },
];

/**
 * 示例消息：展示非线性树的多层讨论结构
 *
 * t1 树结构（在 relations 中定义）：
 *   m1（根：AI取代论）
 *     └─[REPLY]  m2（反驳：AI创造新职业）
 *         ├─[SUPPORT] m4（历史比较论支持m2）
 *         └─[OPPOSE]  m3（不平等论反对m2）
 *             └─[CORRECT] m5（数据纠正m3的说法）
 *   m6（根：政策建议，独立线程）
 *     └─[REPLY] m7（追问政策细节）
 */
const messages: Message[] = [
  {
    id: 'm1',
    topicId: 't1',
    contentType: 'TEXT',
    content: 'AI确实在很多领域取代了重复性劳动，比如流水线工人、数据录入员等。这是不可避免的趋势，历史上没有任何技术浪潮能被阻止。',
    createdAt: '2024-02-02T10:00:00Z',
    createdBy: users[0],
  },
  {
    id: 'm2',
    topicId: 't1',
    contentType: 'TEXT',
    content: '但是AI也在创造新的工作机会，比如AI训练师、提示词工程师等新职业正在涌现。净效应未必是负的。',
    createdAt: '2024-02-03T11:00:00Z',
    createdBy: users[1],
  },
  {
    id: 'm3',
    topicId: 't1',
    contentType: 'TEXT',
    content: '新职业集中在高学历群体，AI的发展反而会加剧贫富分化——没有技能的低收入群体将首当其冲被淘汰。',
    createdAt: '2024-02-04T12:00:00Z',
    createdBy: users[2],
  },
  {
    id: 'm4',
    topicId: 't1',
    contentType: 'TEXT',
    content: '历史上每次技术革命都带来了就业结构的变化，但整体就业并未减少。工业革命如此，信息革命如此，AI很可能也是如此。',
    createdAt: '2024-02-05T09:00:00Z',
    createdBy: users[0],
  },
  {
    id: 'm5',
    topicId: 't1',
    contentType: 'TEXT',
    content: '需要纠正一点：根据麦肯锡2023年报告，AI创造的新岗位目前主要集中在大城市和受过高等教育的人群，短期内确实存在结构性失业风险，这与m3的判断部分吻合，但程度没有那么极端。',
    createdAt: '2024-02-06T08:00:00Z',
    createdBy: users[1],
  },
  {
    id: 'm6',
    topicId: 't1',
    contentType: 'TEXT',
    content: '无论结论如何，政策层面应当建立"再培训基金"，对被AI替代的工人提供职业转型支持，这是共识层面最低成本的应对。',
    createdAt: '2024-02-07T10:00:00Z',
    createdBy: users[2],
  },
  {
    id: 'm7',
    topicId: 't1',
    contentType: 'TEXT',
    content: '再培训基金听起来好，但资金从哪里来？对AI企业征收"自动化税"是可行方案吗？',
    createdAt: '2024-02-08T09:00:00Z',
    createdBy: users[0],
  },
  // t2 消息
  {
    id: 'm8',
    topicId: 't2',
    contentType: 'TEXT',
    content: '远程办公让我节省了每天2小时的通勤时间，工作效率反而提高了20%，健康状况也改善了。',
    createdAt: '2024-02-06T10:00:00Z',
    createdBy: users[1],
  },
  {
    id: 'm9',
    topicId: 't2',
    contentType: 'TEXT',
    content: '居家办公的边界感很差，经常出现工作时间延长、无法切换的问题；而且团队协作和创新需要面对面，完全远程会影响凝聚力。',
    createdAt: '2024-02-07T14:00:00Z',
    createdBy: users[2],
  },
  {
    id: 'm10',
    topicId: 't2',
    contentType: 'TEXT',
    content: '混合办公（每周2-3天在家，其余到岗）可以兼顾两者优势，这已经是很多科技公司的共识。',
    createdAt: '2024-02-08T16:00:00Z',
    createdBy: users[0],
  },
  // t3 消息
  {
    id: 'm11',
    topicId: 't3',
    contentType: 'TEXT',
    content: '乡村振兴的关键在于产业振兴，没有产业支撑的振兴只是空谈。文化保护是奢侈品，先解决温饱再谈文化。',
    createdAt: '2024-01-16T10:00:00Z',
    createdBy: users[1],
  },
  {
    id: 'm12',
    topicId: 't3',
    contentType: 'TEXT',
    content: '数字经济为农村发展提供了新机遇，电商直播让农产品直达消费者，这本身就是产业+文化的结合。',
    createdAt: '2024-01-20T11:00:00Z',
    createdBy: users[2],
  },
  {
    id: 'm13',
    topicId: 't3',
    contentType: 'TEXT',
    content: '不能把"先产业后文化"当作对立命题，传统手工艺、民俗旅游本身就是高附加值产业，文化保护就是产业振兴。',
    createdAt: '2024-01-22T09:00:00Z',
    createdBy: users[0],
  },
];

/**
 * 关系数据：定义消息之间的非线性连接
 * 关系本身也是可查询、可追溯的信息节点
 *
 * t1 树：
 *   m2 -[REPLY]→   m1
 *   m4 -[SUPPORT]→ m2
 *   m3 -[OPPOSE]→  m2
 *   m5 -[CORRECT]→ m3
 *   m7 -[REPLY]→   m6
 *
 * t2 树：
 *   m9  -[OPPOSE]→  m8
 *   m10 -[REPLY]→   m9
 *
 * t3 树：
 *   m12 -[OPPOSE]→  m11  （"数字经济"反对"纯产业论"）
 *   m13 -[CORRECT]→ m11  （"文化即产业"纠正m11）
 */

const relations: Relation[] = [
  // t1: m2 回复 m1（反驳AI取代论）
  { id: 'r1', topicId: 't1', relationType: 'REPLY',   sourceMessageId: 'm2', targetRefs: [{ targetMessageId: 'm1' }], createdAt: '2024-02-03T11:30:00Z', createdBy: users[1] },
  // t1: m4 支持 m2（历史比较论支持新职业论）
  { id: 'r2', topicId: 't1', relationType: 'SUPPORT', sourceMessageId: 'm4', targetRefs: [{ targetMessageId: 'm2' }], createdAt: '2024-02-05T10:00:00Z', createdBy: users[0] },
  // t1: m3 反对 m2（不平等论反对新职业论）
  { id: 'r3', topicId: 't1', relationType: 'OPPOSE',  sourceMessageId: 'm3', targetRefs: [{ targetMessageId: 'm2' }], createdAt: '2024-02-04T13:00:00Z', createdBy: users[2] },
  // t1: m5 纠正 m3（引用报告数据纠正不平等论的程度）
  { id: 'r4', topicId: 't1', relationType: 'CORRECT', sourceMessageId: 'm5', targetRefs: [{ targetMessageId: 'm3' }], createdAt: '2024-02-06T09:00:00Z', createdBy: users[1] },
  // t1: m7 回复 m6（追问再培训基金的资金来源）
  { id: 'r5', topicId: 't1', relationType: 'REPLY',   sourceMessageId: 'm7', targetRefs: [{ targetMessageId: 'm6' }], createdAt: '2024-02-08T09:30:00Z', createdBy: users[0] },
  // t2: m9 反对 m8
  { id: 'r6', topicId: 't2', relationType: 'OPPOSE',  sourceMessageId: 'm9',  targetRefs: [{ targetMessageId: 'm8' }],  createdAt: '2024-02-07T15:00:00Z', createdBy: users[2] },
  // t2: m10 回复 m9（混合办公方案）
  { id: 'r7', topicId: 't2', relationType: 'REPLY',   sourceMessageId: 'm10', targetRefs: [{ targetMessageId: 'm9' }],  createdAt: '2024-02-08T17:00:00Z', createdBy: users[0] },
  // t3: m12 反对 m11
  { id: 'r8', topicId: 't3', relationType: 'OPPOSE',  sourceMessageId: 'm12', targetRefs: [{ targetMessageId: 'm11' }], createdAt: '2024-01-20T12:00:00Z', createdBy: users[2] },
  // t3: m13 纠正 m11（文化即产业）
  { id: 'r9', topicId: 't3', relationType: 'CORRECT', sourceMessageId: 'm13', targetRefs: [{ targetMessageId: 'm11' }], createdAt: '2024-01-22T10:00:00Z', createdBy: users[0] },
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
    id: genId(),
    title: data.title,
    body: data.body,
    status: 'OPEN',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    createdBy: mockUser,
    _count: { messages: 0, relations: 0 },
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
  quoteSourceId?: string;
  quotedText?: string;
  quoteContextBefore?: string;
  quoteContextAfter?: string;
}) {
  await delay();
  if (!mockUser) throw new Error('请先登录');
  const msg: Message = {
    id: genId(),
    topicId,
    contentType: data.contentType || 'TEXT',
    content: data.content,
    quoteSourceId: data.quoteSourceId,
    quotedText: data.quotedText,
    quoteContextBefore: data.quoteContextBefore,
    quoteContextAfter: data.quoteContextAfter,
    createdAt: new Date().toISOString(),
    createdBy: mockUser,
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
  sourceMessageId: string;
  targetRefs: TargetRef[];
}) {
  await delay();
  if (!mockUser) throw new Error('请先登录');
  const rel: Relation = {
    id: genId(),
    topicId,
    relationType: data.relationType,
    sourceMessageId: data.sourceMessageId,
    targetRefs: data.targetRefs,
    createdAt: new Date().toISOString(),
    createdBy: mockUser,
  };
  relations.push(rel);
  return rel;
}
