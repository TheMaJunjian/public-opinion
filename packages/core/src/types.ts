export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A reference addresses identity, a pinned revision, a component, or a value inside it. */
export interface Reference {
  messageId: string;
  revision?: number;
  partId?: string;
  memberId?: string;
  path?: (string | number)[];
  range?: { start: number; end: number };
}

export interface Binding { id: string; reference: Reference }

export type Part =
  | { id: string; type: 'text'; text: string }
  | { id: string; type: 'web'; url: string; excerpt: string }
  | { id: string; type: 'code'; language: string; source: string }
  | { id: string; type: 'relation'; relation: string; roles: Record<string, Binding[]> }
  | { id: string; type: 'display'; relationPartId: string; layout: 'flow' | 'columns' | 'row' | 'summary'; target?: Reference; order?: string[] }
  | { id: string; type: 'data'; value: Json };

export interface Message {
  id: string;
  revision: number;
  authorId: string;
  createdAt: string;
  updatedAt: string;
  regionId: string;
  ledgerId: string;
  programVersion: string;
  ruleVersion: number;
  parts: Part[];
  spending: { protocol: number; recommendation: number; wager: number };
  sequence: number;
}
export interface User { id: string; name: string; username?: string; founder: boolean; createdAt?: string; publicKey?: string | null }
export interface Account { available: number; locked: number; earned: number; spent: number }
export interface Rules {
  version: number;
  protocolFee: number;
  initialGrant: number;
  operatingReserve: number;
  lowQualityPenalty: number;
  settlementDelayMs: number;
  contributionWeights: {
    content: number; relation: number; agreement: number; evidence: number;
    duplicate: number; earlyBonus: number; earlyWindow: number; unrecognizedAuthorCap: number;
  };
}
export const DEFAULT_RULES: Rules = {
  version: 1, protocolFee: 1, initialGrant: 1000, operatingReserve: 100,
  lowQualityPenalty: 5, settlementDelayMs: 0,
  contributionWeights: { content: 3, relation: 2, agreement: 1, evidence: 5, duplicate: 0, earlyBonus: 1, earlyWindow: 20, unrecognizedAuthorCap: 8 },
};
export interface Round {
  id: string; target: Reference; targetRevision: number; status: 'open' | 'waiting' | 'settled';
  pro: number; con: number; result: 'pro' | 'con' | 'tie' | null;
  previousRoundId: string | null; distributionId: string | null; endsAt: string | null;
}
export interface Membership { memberId: string; parentId: string; sourceId: string; sourcePartId?: string; bindingId?: string; sourceRevision?: number }
export interface LedgerEntry {
  id: string; userId: string; messageId: string; messageRevision: number; amount: number; lockedDelta: number;
  reason: string; createdAt: string; ruleVersion: number;
}
export interface Allocation { userId: string; amount: number; reason: string; messageIds: string[] }
export interface Distribution {
  source: 'wager' | 'operations' | 'delegation' | 'penalty' | 'reversal' | 'grant';
  total: number; ruleVersion: number; ledgerId: string; programVersion: string; inputs: Json; allocations: Allocation[];
}
export interface SendInput {
  requestId: string;
  parts: Part[];
  recommendation?: number;
  wager?: number;
  selfStance?: 'pro' | 'con';
}
export interface ExecutedStance {
  partId: string;
  sourceRevision: number;
  target: Reference;
  side: 'pro' | 'con';
}
export interface MessageState {
  messageId: string; revision: number; suppressed: boolean;
  supportCount: number; oppositionCount: number; recommendationTotal: number;
  executedStance?: ExecutedStance;
  membershipActive?: boolean;
}
export interface Change {
  sequence: number;
  /** Previous committed cursor; PostgreSQL may consume sequence values on rollback. */
  previousSequence?: number;
  messages: Message[]; memberships: Membership[];
  removedMemberships: string[];
  states: MessageState[];
  ledger: LedgerEntry[];
  treasury: { operating: number; issued: number };
}
export interface Page {
  messages: Message[]; users: User[]; memberships: Membership[];
  nextCursor: string | null; sequence: number;
  states: MessageState[];
}
export interface Context extends Page { rounds: Round[] }
export interface Session { user: User; account: Account; rules: Rules; csrf: string }
export interface SendResult { message: Message; change: Change; account: Account }

export const ORGANIZATIONS = new Set(['classify', 'merge', 'summary', 'arrange']);
export const RELATION_LABELS: Record<string, string> = {
  classify: '分类', merge: '归并', summary: '总结', arrange: '排列', 'member-of': '加入', presentation: '显示方案',
  agree: '赞同', disagree: '反对', reply: '回复', reference: '引用', annotation: '注释',
  evidence: '证据', question: '疑问', answer: '回答', tag: '标注', recommend: '推荐',
  terminate: '终止结算', distribution: '分配', amend: '修改', authorize: '授权生效',
  'rule-change': '规则修改', 'low-quality': '低质量评价', delegate: '委托', fulfill: '完成委托',
  follow: '关注', unfollow: '取消关注', block: '屏蔽', unblock: '取消屏蔽',
  read: '已读', unread: '未读', archive: '冷藏', notify: '通知',
  distribute: '分配运营收入', credit: '发放贡献点', recharge: '充值申请', release: '版本发布',
};
