import type { User, Topic, Message, Relation, PaginatedResponse, TargetRef } from '../types';

const delay = (ms = 150) => new Promise(res => setTimeout(res, ms));

const users: User[] = [
  { id: 'u1', username: 'alice', createdAt: '2024-01-01T00:00:00Z' },
  { id: 'u2', username: 'bob', createdAt: '2024-01-02T00:00:00Z' },
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
    _count: { messages: 4, relations: 3 },
  },
  {
    id: 't2',
    title: '远程办公的利与弊',
    body: '疫情之后，远程办公成为新常态。这种工作方式对员工和企业究竟带来了哪些影响？',
    status: 'OPEN',
    createdAt: '2024-02-05T09:00:00Z',
    updatedAt: '2024-02-12T11:00:00Z',
    createdBy: users[1],
    _count: { messages: 3, relations: 2 },
  },
  {
    id: 't3',
    title: '城市化进程与乡村振兴',
    body: '中国城镇化率已超过65%，但农村地区仍面临人口外流、产业空心化等问题。',
    status: 'ARCHIVED',
    createdAt: '2024-01-15T08:00:00Z',
    updatedAt: '2024-01-30T16:00:00Z',
    createdBy: users[2],
    _count: { messages: 2, relations: 1 },
  },
];

const messages: Message[] = [
  {
    id: 'm1',
    topicId: 't1',
    contentType: 'TEXT',
    content: 'AI确实在很多领域取代了重复性劳动，比如流水线工人、数据录入员等。这是不可避免的趋势。',
    createdAt: '2024-02-02T10:00:00Z',
    createdBy: users[0],
  },
  {
    id: 'm2',
    topicId: 't1',
    contentType: 'TEXT',
    content: '但是AI也在创造新的工作机会，比如AI训练师、提示词工程师等新职业正在涌现。',
    createdAt: '2024-02-03T11:00:00Z',
    createdBy: users[1],
  },
  {
    id: 'm3',
    topicId: 't1',
    contentType: 'TEXT',
    content: '我认为AI的发展会导致贫富差距扩大，掌握AI技术的人会获益，而没有技能的人会被淘汰。',
    createdAt: '2024-02-04T12:00:00Z',
    createdBy: users[2],
  },
  {
    id: 'm4',
    topicId: 't1',
    contentType: 'TEXT',
    content: '历史上每次技术革命都带来了就业结构的变化，工业革命并没有让大多数人失业，AI也是如此。',
    createdAt: '2024-02-05T09:00:00Z',
    createdBy: users[0],
  },
  {
    id: 'm5',
    topicId: 't2',
    contentType: 'TEXT',
    content: '远程办公让我节省了每天2小时的通勤时间，工作效率反而提高了。',
    createdAt: '2024-02-06T10:00:00Z',
    createdBy: users[1],
  },
  {
    id: 'm6',
    topicId: 't2',
    contentType: 'TEXT',
    content: '但是居家办公的边界感很差，经常出现工作时间延长、难以切换到生活状态的问题。',
    createdAt: '2024-02-07T14:00:00Z',
    createdBy: users[2],
  },
  {
    id: 'm7',
    topicId: 't2',
    contentType: 'TEXT',
    content: '团队协作和创新需要面对面交流，完全远程会影响团队凝聚力和创造力。',
    createdAt: '2024-02-08T16:00:00Z',
    createdBy: users[0],
  },
  {
    id: 'm8',
    topicId: 't3',
    contentType: 'TEXT',
    content: '乡村振兴的关键在于产业振兴，没有产业支撑的振兴只是空谈。',
    createdAt: '2024-01-16T10:00:00Z',
    createdBy: users[1],
  },
  {
    id: 'm9',
    topicId: 't3',
    contentType: 'TEXT',
    content: '数字经济为农村发展提供了新机遇，电商直播让农产品直达消费者。',
    createdAt: '2024-01-20T11:00:00Z',
    createdBy: users[2],
  },
];

const relations: Relation[] = [
  {
    id: 'r1',
    topicId: 't1',
    relationType: 'SUPPORT',
    sourceMessageId: 'm4',
    targetRefs: [{ targetMessageId: 'm2' }],
    createdAt: '2024-02-05T10:00:00Z',
    createdBy: users[0],
  },
  {
    id: 'r2',
    topicId: 't1',
    relationType: 'OPPOSE',
    sourceMessageId: 'm3',
    targetRefs: [{ targetMessageId: 'm2' }],
    createdAt: '2024-02-04T13:00:00Z',
    createdBy: users[2],
  },
  {
    id: 'r3',
    topicId: 't1',
    relationType: 'REPLY',
    sourceMessageId: 'm2',
    targetRefs: [{ targetMessageId: 'm1' }],
    createdAt: '2024-02-03T11:30:00Z',
    createdBy: users[1],
  },
  {
    id: 'r4',
    topicId: 't2',
    relationType: 'OPPOSE',
    sourceMessageId: 'm6',
    targetRefs: [{ targetMessageId: 'm5' }],
    createdAt: '2024-02-07T15:00:00Z',
    createdBy: users[2],
  },
  {
    id: 'r5',
    topicId: 't2',
    relationType: 'SUPPORT',
    sourceMessageId: 'm7',
    targetRefs: [{ targetMessageId: 'm6' }],
    createdAt: '2024-02-08T17:00:00Z',
    createdBy: users[0],
  },
  {
    id: 'r6',
    topicId: 't3',
    relationType: 'CORRECT',
    sourceMessageId: 'm9',
    targetRefs: [{ targetMessageId: 'm8' }],
    createdAt: '2024-01-20T12:00:00Z',
    createdBy: users[2],
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
