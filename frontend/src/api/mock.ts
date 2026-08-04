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

import type {
  User,
  Topic,
  Message,
  Relation,
  PaginatedResponse,
  TargetRef,
  RelationPayload,
  SettlementRoundItem,
  SettlementResult,
  AuditLogEntry,
  RevenuePoolData,
  RevenueDistributionItem,
  StanceHistoryResponse,
  StanceRelation,
  StanceStake,
  StanceTag,
} from '../types';

const delay = (ms = 150) => new Promise(res => setTimeout(res, ms));

const users: User[] = [
  { id: 'u1', username: '用户1', createdAt: '2024-01-01T00:00:00Z' },
  { id: 'u2', username: '用户2', createdAt: '2024-01-02T00:00:00Z' },
];

const topics: Topic[] = [
  {
    id: 't1',
    title: '富人和穷人谁更有钱？',
    body: '一个关于财富分配的基础辩论：富人比穷人有钱，还是穷人比富人有钱？',
    status: 'OPEN',
    createdAt: '2024-02-01T10:00:00Z',
    updatedAt: '2024-02-10T15:00:00Z',
    createdBy: users[0],
    _count: { messages: 3 },
  },
];

/**
 * t1 消息结构：
 *   消息A (m1): 用户1 — "富人比穷人有钱。"
 *   消息B (m2): 用户1 — "很显然，这是对的。"  →  [支持] → 消息A
 *   消息C (m3): 用户2 — "不对，穷人比富人有钱，因为穷人人多。"  →  [反对] → 消息A
 */
const messages: Message[] = ([
  {
    id: 'm1', topicId: 't1', contentType: 'TEXT',
    content: '富人比穷人有钱。',
    createdAt: '2024-02-02T10:00:00Z', createdBy: users[0],
  },
  {
    id: 'm2', topicId: 't1', contentType: 'TEXT',
    content: '很显然，这是对的。',
    createdAt: '2024-02-03T11:00:00Z', createdBy: users[0],
  },
  {
    id: 'm3', topicId: 't1', contentType: 'TEXT',
    content: '不对，穷人比富人有钱，因为穷人人多。',
    createdAt: '2024-02-04T12:00:00Z', createdBy: users[1],
  },
] satisfies Array<Omit<Message, 'kind'>>).map(message => ({ kind: 'TEXT', ...message }));

/**
 * Relations:
 *   r1: 用户1 — 消息B 支持(AGREE) → 消息A
 *   r2: 用户2 — 消息C 反对(DISAGREE) → 消息A
 */
const relations: Relation[] = [
  // r1: m2 (消息B) AGREE → m1 (消息A)
  {
    id: 'r1', topicId: 't1', relationType: 'AGREE',
    sourceMessageId: 'm2',
    targetRefs: [{ kind: 'message', messageId: 'm1' }],
    createdAt: '2024-02-03T11:30:00Z', createdBy: users[0],
  },
  // r2: m3 (消息C) DISAGREE → m1 (消息A)
  {
    id: 'r2', topicId: 't1', relationType: 'DISAGREE',
    sourceMessageId: 'm3',
    targetRefs: [{ kind: 'message', messageId: 'm1' }],
    createdAt: '2024-02-04T13:00:00Z', createdBy: users[1],
  },
];

let mockToken: string | null = null;
let mockUser: User = users[0]; // Auto-login as demo user (用户1)
let nextId = 100;

// Initialize demo token
mockToken = `mock-token-${mockUser.id}`;

function genId() { return `mock-${++nextId}`; }

function paginate<T>(arr: T[], page = 1, limit = 20): PaginatedResponse<T> {
  const start = (page - 1) * limit;
  const data = arr.slice(start, start + limit);
  return { data, pagination: { page, limit, total: arr.length, totalPages: Math.ceil(arr.length / limit) } };
}

export async function register(data: { username: string; password: string; publicKey?: string | null }) {
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
  mockToken = `mock-token-${users[0].id}`;
  mockUser = users[0]; // Reset to demo user
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
  if (!topic) throw new Error('分类不存在');
  return topic;
}

export async function updateTopic(id: string, data: { status: 'OPEN' | 'ARCHIVED' }) {
  await delay();
  const topic = topics.find(t => t.id === id);
  if (!topic) throw new Error('分类不存在');
  topic.status = data.status;
  topic.updatedAt = new Date().toISOString();
  return topic;
}

export async function getMessages(topicId: string, params?: { page?: number; limit?: number }) {
  await delay();
  const filtered = messages.filter(m => m.topicId === topicId);
  return paginate(filtered, params?.page, params?.limit);
}

export async function getUser(userId: string) {
  const message = messages.find(item => item.createdBy.id === userId);
  return message?.createdBy ?? { id: userId, username: userId, createdAt: new Date().toISOString() };
}

export async function getUserMessages(userId: string, params?: { page?: number; limit?: number }) {
  const all = messages.filter(message => message.createdBy.id === userId);
  const page = params?.page ?? 1;
  const limit = params?.limit ?? 50;
  return { data: all.slice((page - 1) * limit, page * limit), pagination: { page, limit, total: all.length, totalPages: Math.ceil(all.length / limit) } };
}

export async function getUserStances(userId: string, params?: { page?: number; limit?: number; topicId?: string }) {
  await delay(80);
  const limit = params?.limit ?? 30;
  // Derive stance relations from AGREE/DISAGREE relations created by the user
  const userRelations = relations
    .filter(r => r.createdBy.id === userId)
    .filter(r => r.relationType === 'AGREE' || r.relationType === 'DISAGREE');
  const filteredRels = params?.topicId
    ? userRelations.filter(r => r.topicId === params.topicId)
    : userRelations;
  const stanceRelations: StanceRelation[] = filteredRels.map(r => {
    const targetMsgId = r.targetRefs[0] && 'messageId' in r.targetRefs[0]
      ? (r.targetRefs[0] as { messageId: string }).messageId
      : null;
    const targetMsg = targetMsgId ? messages.find(m => m.id === targetMsgId) : null;
    const topic = topics.find(t => t.id === r.topicId);
    return {
      kind: 'relation' as const,
      id: r.id,
      relationMessageId: r.sourceMessageId ?? r.id,
      topicId: r.topicId,
      topicTitle: topic?.title ?? r.topicId,
      type: r.relationType,
      amount: 10,
      targetMessageId: targetMsgId,
      messageKind: targetMsg?.kind ?? 'TEXT',
      targetRelationType: null,
      content: targetMsg?.content ?? '',
      createdAt: r.createdAt,
    };
  });
  // Derive stance stakes from messages created by the user (self-stake)
  const userMsgs = params?.topicId
    ? messages.filter(m => m.createdBy.id === userId && m.topicId === params.topicId)
    : messages.filter(m => m.createdBy.id === userId);
  const stanceStakes: StanceStake[] = userMsgs.map(m => {
    const topic = topics.find(t => t.id === m.topicId);
    return {
      kind: 'stake' as const,
      id: m.id,
      topicId: m.topicId,
      topicTitle: topic?.title ?? m.topicId,
      messageId: m.id,
      messageKind: m.kind ?? 'TEXT',
      content: m.content,
      amount: 10,
      createdAt: m.createdAt,
    };
  });
  // Tags: RECOMMEND/ARCHIVE/TAG relations created by the user
  const userTags = relations
    .filter(r => r.createdBy.id === userId)
    .filter(r => r.relationType === 'RECOMMEND' || r.relationType === 'ARCHIVE' || r.relationType === 'TAG');
  const filteredTags = params?.topicId
    ? userTags.filter(r => r.topicId === params.topicId)
    : userTags;
  const stanceTags: StanceTag[] = filteredTags.map(r => {
    const targetMsgId = r.targetRefs[0] && 'messageId' in r.targetRefs[0]
      ? (r.targetRefs[0] as { messageId: string }).messageId
      : null;
    const topic = topics.find(t => t.id === r.topicId);
    return {
      kind: 'tag' as const,
      id: r.id,
      relationMessageId: r.sourceMessageId ?? r.id,
      topicId: r.topicId,
      topicTitle: topic?.title ?? r.topicId,
      relationType: r.relationType,
      label: r.relationType,
      subType: r.payload?.subType ?? null,
      customLabel: r.payload?.customLabel ?? null,
      targetMessageId: targetMsgId,
      amount: 5,
      createdAt: r.createdAt,
    };
  });
  return {
    user: { id: userId },
    stances: {
      relations: stanceRelations.slice(0, limit),
      stakes: stanceStakes.slice(0, limit),
      tags: stanceTags.slice(0, limit),
    },
    pagination: {
      page: params?.page ?? 1,
      limit,
      totalRelations: stanceRelations.length,
      totalStakes: stanceStakes.length,
      totalTags: stanceTags.length,
    },
  } satisfies StanceHistoryResponse;
}

export async function createMessage(topicId: string, data: {
  kind?: 'TEXT' | 'GOVERNANCE' | 'CODE' | 'ROUND' | 'ROUND_RESULT' | 'OPERATIONS';
  contentType?: 'TEXT' | 'MARKDOWN';
  content?: string;
  stakeAmount?: number;
  targetMessageId?: string;
  note?: string;
  settlementType?: string;
  relationPayload?: Record<string, unknown>;
}) {
  await delay();
  
  const msg: Message = {
    id: genId(), topicId, kind: data.kind ?? 'TEXT', contentType: data.contentType || 'TEXT',
    content: data.content ?? '', createdAt: new Date().toISOString(), createdBy: mockUser,
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

export async function getAttentionUsers(topicId: string) {
  await delay();
  const data: Record<string, string[]> = {};
  const attentionRelations = relations.filter(r => r.topicId === topicId && r.relationType.toUpperCase() === 'ATTENTION');
  for (const attentionRelation of attentionRelations) {
    for (const target of attentionRelation.targetRefs) {
      if (target.kind !== 'message' && target.kind !== 'text-fragment') continue;
      const users = data[target.messageId] ?? [];
      if (!users.includes(attentionRelation.createdBy.id)) users.push(attentionRelation.createdBy.id);
      data[target.messageId] = users;
    }
  }
  return { data };
}

export async function createRelation(topicId: string, data: {
  relationType: string;
  sourceMessageId?: string | null;
  targetRefs: TargetRef[];
  payload?: import('../types').RelationPayload;
}) {
  await delay();
  
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
  relationType: string;
  targetRefs: TargetRef[];
  payload?: RelationPayload;
}) {
  await delay();
  
  const oldIdx = relations.findIndex(r => r.id === relationId && r.topicId === topicId);
  if (oldIdx === -1) throw new Error('关系消息不存在');
  const oldRel = relations[oldIdx];
  const newRel: Relation = {
    id: `rel-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    topicId,
    relationType: data.relationType,
    sourceMessageId: oldRel.sourceMessageId,
    targetRefs: data.targetRefs,
    payload: data.payload ?? oldRel.payload,
    createdAt: new Date().toISOString(),
    createdBy: { id: mockUser.id, username: mockUser.username, createdAt: mockUser.createdAt },
  };
  relations.push(newRel);
  return newRel;
}

export async function patchRelationTargets(topicId: string, relationId: string, targetRefs: TargetRef[]) {
  await delay();
  
  const idx = relations.findIndex(r => r.id === relationId && r.topicId === topicId);
  if (idx === -1) throw new Error('关系消息不存在');
  relations[idx] = { ...relations[idx], targetRefs };
  return relations[idx];
}

// ============================================================
// Points & Rules Mock API (Phase 1)
// ============================================================

export async function getPointsBalance() {
  await delay(50);
  
  return {
    points: { available: 100, locked: 0 },
    balance: { amount: 100, debtFrozen: false },
    breakdown: {
      initialMinted: 100,
      totalEarned: 0,
      totalLost: 0,
      totalProtocolFees: 0,
    },
  };
}

export async function getPointsTransactions(params?: { page?: number; limit?: number }) {
  await delay(50);
  
  return {
    data: [
      {
        id: 'pt-1',
        type: 'MINT',
        amount: 100,
        balanceAfter: 100,
        createdAt: new Date().toISOString(),
        data: { reason: 'REGISTRATION_BONUS' },
      },
    ],
    pagination: { page: params?.page ?? 1, limit: params?.limit ?? 20, total: 1, totalPages: 1 },
  };
}

export async function getCurrentRules() {
  await delay(50);
  return {
    id: 'rule-v1',
    version: 1,
    status: 'ACTIVE',
    description: '初始默认规则 — 线性权重、最小押注 1、无单注上限',
    parameters: {
      minStake: 1,
      maxSingleStake: null,
      weightFunction: 'linear',
      concurrentRoundLimit: 1,
    },
    createdAt: '2024-01-01T00:00:00Z',
  };
}

// ============================================================
// Stake Mock API (Phase 2)
// ============================================================

const mockStakes: Record<string, { pro: number; con: number }> = {};

export async function placeStake(messageId: string, data: { side: 'PRO' | 'CON'; amount: number }) {
  await delay(100);
  
  if (!mockStakes[messageId]) mockStakes[messageId] = { pro: 0, con: 0 };
  mockStakes[messageId][data.side === 'PRO' ? 'pro' : 'con'] += data.amount;
  return {
    message: '押注成功',
    stakeId: `stake-${Date.now()}`,
    side: data.side,
    amount: data.amount,
    newAvailable: 99,
    newLocked: 1,
    newBalance: 99,
  };
}

export async function getMessageStakes(messageId: string, settlementType?: 'TRUTH' | 'VALUE') {
  await delay(50);
  const pool = mockStakes[messageId] ?? { pro: 0, con: 0 };
  const resolvedType = settlementType ?? 'TRUTH';
  return {
    messageId,
    pool: { lockedPro: pool.pro, lockedCon: pool.con },
    pools: { [resolvedType]: { lockedPro: pool.pro, lockedCon: pool.con } },
    stakes: [],
    counts: { pro: pool.pro, con: pool.con },
    countsByType: {
      TRUTH: resolvedType === 'TRUTH' ? { pro: pool.pro, con: pool.con } : { pro: 0, con: 0 },
      VALUE: resolvedType === 'VALUE' ? { pro: pool.pro, con: pool.con } : { pro: 0, con: 0 },
    },
  };
}

// ============================================================
// Settlement Mock API (Phase 3)
// ============================================================

const mockRounds: SettlementRoundItem[] = [];

export async function createRound(messageId: string, data?: { note?: string; settlementType?: 'TRUTH' | 'VALUE' }) {
  await delay(100);
  
  const round: SettlementRoundItem & { roundMessageId: string } = {
    id: genId(),
    roundMessageId: genId(),
    messageId,
    createdByUserId: mockUser.id,
    createdBy: mockUser,
    status: 'VOTING',
    settlementType: data?.settlementType ?? 'TRUTH',
    result: null,
    previousRoundId: null,
    openedAt: new Date().toISOString(),
    closedAt: null,
    note: data?.note ?? null,
    votes: [],
    _count: { votes: 0 },
    weights: { TRUE: 0, FALSE: 0, UNKNOWN: 0 },
  };
  mockRounds.unshift(round);
  return round;
}

export async function getMessageRounds(messageId: string) {
  await delay(50);
  return { data: mockRounds.filter(round => round.messageId === messageId) };
}

export async function getRoundDetail(roundId: string) {
  await delay(50);
  const round = mockRounds.find(r => r.id === roundId);
  if (!round) throw new Error('结算轮次不存在');
  return round;
}

export async function castVote(roundId: string, data: { vote: 'TRUE' | 'FALSE'; amount: number }) {
  await delay(100);
  
  const round = mockRounds.find(r => r.id === roundId);
  if (!round) throw new Error('结算轮次不存在');
  round.votes = [
    ...(round.votes ?? []),
    { id: genId(), vote: data.vote, amount: data.amount, createdAt: new Date().toISOString(), user: mockUser },
  ];
  round._count = { votes: round.votes.length };
  round.weights = {
    TRUE: (round.weights?.TRUE ?? 0) + (data.vote === 'TRUE' ? data.amount : 0),
    FALSE: (round.weights?.FALSE ?? 0) + (data.vote === 'FALSE' ? data.amount : 0),
    UNKNOWN: round.weights?.UNKNOWN ?? 0,
  };
  return { message: '投票成功', id: genId(), topicId: '', relationType: data.vote === 'TRUE' ? 'AGREE' : 'DISAGREE', sourceMessageId: null, targetRefs: [{ kind: 'message', messageId: round.messageId }], createdAt: new Date().toISOString(), createdBy: mockUser } as Relation & { message: string };
}

export async function closeAndSettle(roundId: string): Promise<SettlementResult> {
  await delay(100);
  const round = mockRounds.find(r => r.id === roundId);
  if (!round) throw new Error('结算轮次不存在');
  const weights = round.weights ?? { TRUE: 0, FALSE: 0, UNKNOWN: 0 };
  const result = weights.TRUE > weights.FALSE ? 'TRUE' : weights.FALSE > weights.TRUE ? 'FALSE' : 'UNKNOWN';
  round.status = 'SETTLED';
  round.result = result;
  round.closedAt = new Date().toISOString();
  const settlementType = round.settlementType ?? 'TRUTH';
  const settlementLabel = settlementType === 'VALUE' ? '价值仲裁' : '真假仲裁';
  const resultLabel = result === 'TRUE' ? '赞成胜出' : result === 'FALSE' ? '反对胜出' : '平局';
  const resultContent = `${settlementLabel}完成：目标消息 ${round.messageId.slice(-8)}；结果：${resultLabel}（${result}）；TRUE 权重 ${weights.TRUE}，FALSE 权重 ${weights.FALSE}`;
  return {
    message: '结算完成',
    roundId,
    messageId: round.messageId,
    settlementType,
    resultContent,
    result,
    weights,
    totalPro: weights.TRUE,
    totalCon: weights.FALSE,
    affectedUsers: round._count?.votes ?? 0,
  };
}

// ============================================================
// Audit Log & Revenue Mock API (Phase 6)
// ============================================================

export async function getAuditLogs(params?: { topicId?: string; page?: number; limit?: number; action?: string; actorId?: string; entityType?: string; entityId?: string }) {
  await delay(50);
  const entries: AuditLogEntry[] = [];
  return paginate(entries.filter(entry => !params?.topicId || entry.topicId === params.topicId), params?.page, params?.limit);
}

export async function getRevenuePool(): Promise<RevenuePoolData> {
  await delay(50);
  return { id: 'revenue-pool-1', totalReceived: 0, totalDistributed: 0, balance: 0, updatedAt: new Date().toISOString() };
}

export async function getRevenueDistributions(params?: { page?: number; limit?: number }) {
  await delay(50);
  const entries: RevenueDistributionItem[] = [];
  return paginate(entries, params?.page, params?.limit);
}

// ============================================================
// Tag Mock
// ============================================================

export async function getTopicTagCounts(_topicId: string) {
  await delay(30);
  return { topicId: _topicId, counts: {} };
}

// ============================================================
// Export Mock
// ============================================================

export async function exportTopic(topicId: string) {
  await delay(100);
  const topic = topics.find(t => t.id === topicId);
  if (!topic) throw new Error('分类不存在');

  const topicMessages = messages.filter(m => m.topicId === topicId);
  const topicRelations = relations.filter(r => r.topicId === topicId);

  return {
    exportedAt: new Date().toISOString(),
    topic: {
      title: topic.title,
      body: topic.body ?? null,
      status: topic.status,
    },
    messages: topicMessages.map(m => ({
      id: m.id,
      kind: m.kind ?? 'TEXT',
      contentType: m.contentType,
      content: m.content,
      createdAt: m.createdAt,
      author: m.createdBy.username,
    })),
    relations: topicRelations.map(r => ({
      id: r.id,
      relationType: r.relationType,
      sourceMessageId: r.sourceMessageId,
      targetRefs: r.targetRefs,
      payload: r.payload ?? null,
      createdAt: r.createdAt,
      author: r.createdBy.username,
    })),
  };
}
