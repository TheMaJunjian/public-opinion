// ============================================================
// Core User & Topic Types
// ============================================================

export interface User {
  id: string;
  username: string;
  createdAt: string;
}

export interface Topic {
  id: string;
  title: string;
  body?: string;
  status: 'OPEN' | 'ARCHIVED';
  createdAt: string;
  updatedAt: string;
  createdBy: User;
  _count?: { messages: number };
}

// ============================================================
// Message Model
// ============================================================

export interface Message {
  id: string;
  topicId: string;
  kind: string;
  contentType: 'TEXT' | 'MARKDOWN';
  content: string;
  createdAt: string;
  createdBy: User;
}

// ============================================================
// Relation Model — Extensible by Design
// ============================================================

/**
 * All currently supported relation types.
 * The union with `string` allows new types to be used without a type system change.
 *
 * Types by presentation category:
 *   Edge-label (directed connector): ANNOTATION, REFERENCE, REPLY
 *   Decoration (badge on target):    AGREE, DISAGREE
 *   Decoration-label (text tag):     TAG
 *   Arrange-frame (border wrap):      ARRANGE
 *   Replace/Overlay:                 CORRECT, SUMMARY
 *   Frame/Group:                     CLASSIFY, MERGE
 *   Inline badge:                    RECOMMEND, ARCHIVE
 *
 * Notes:
 *   AGREE/DISAGREE: when accompanied by a text message, function as support/rebut.
 *   SUPPORT and REBUT have been removed; their semantics are covered by AGREE/DISAGREE+text.
 */
export type RelationType =
  | 'ANNOTATION'   // 注释
  | 'REFERENCE'    // 引用
  | 'REPLY'        // 回复
  | 'AGREE'        // 赞同（有文本时视为支持）
  | 'DISAGREE'     // 反对（有文本时视为反驳）
  | 'TAG'          // 标注（消息旁的装饰标签）
  | 'CORRECT'      // 更正
  | 'ARRANGE'      // 排列（边框包裹目标消息；payload.targetLayout 控制横/纵排列）
  | 'CLASSIFY'     // 分类
  | 'MERGE'        // 归并
  | 'SUMMARY'      // 总结
  | 'RECOMMEND'    // 推荐
  | 'ARCHIVE'      // 冷藏
  | 'OPERATIONS'   // 运营（收入、统计等程序运营信息）
  | string;        // future extensibility

/**
 * TargetRef — a discriminated union representing what a relation points to.
 *
 * This is the core fix for the "relation message targeting" bug.
 * Old format (broken): { targetMessageId: string } always resolved to a text message.
 * New format: explicitly distinguishes between text messages and relation messages.
 *
 * Constraints (enforced in UI):
 *   Sources: only 'message' or 'text-fragment' (text messages and their fragments)
 *   Targets: any kind — text messages, fragments, or relation messages/parts
 */
export type TargetRef =
  | { kind: 'message'; messageId: string }
  | {
      kind: 'text-fragment';
      messageId: string;
      text: string;
      hash: string;
      contextBefore?: string;
      contextAfter?: string;
    }
  | {
      kind: 'relation';
      relationId: string;
      /** Which selectable part of the relation is targeted */
      part?: 'label' | 'decoration' | 'frame' | 'whole';
    };

export type RelationTargetLayout = 'single-column' | 'multi-column' | 'single-row';

export interface RelationPayload {
  label?: string;
  title?: string;
  targetLayout?: RelationTargetLayout;
  content?: string;
  subType?: 'SPAM' | 'OFFTOPIC' | 'LOWVALUE' | 'IMPORTANT' | 'CUSTOM';
  customLabel?: string;
}

export interface Relation {
  id: string;
  topicId: string;
  relationType: RelationType;
  /**
   * ID of the text message that "sends" / authors this relation.
   * Nullable for AGREE/DISAGREE pure-stance relations (no attached text message).
   * Also null for TAG and MERGE relations (user-to-message relations).
   */
  sourceMessageId: string | null;
  targetRefs: TargetRef[];
  payload?: RelationPayload;
  createdAt: string;
  createdBy: User;
}

// ============================================================
// Presentation Layer — PresentationSpec abstraction
// ============================================================

/**
 * PresentationKind — how a relation message is rendered.
 *
 * This abstraction decouples GraphView from the assumption "relation = edge".
 * Adding a new relation type only requires:
 *   1. Adding its type string to RelationType
 *   2. Adding a PresentationSpec entry in PRESENTATION_SPECS
 *   3. Optionally adding rendering logic for a new PresentationKind
 */
export type PresentationKind =
  | 'edge-label'        // Directed connector with a clickable label
  | 'decoration'        // Badge/decoration attached to target message card (right side)
  | 'decoration-label'  // Text label badge attached to target message card
  | 'arrange-frame'     // Border frame wrapping target messages (vertical or horizontal layout)
  | 'frame-group'       // Frames a group of messages
  | 'replace-overlay'   // Overlays / replaces the target message display (e.g. SUMMARY)
  | 'correction-badge'  // Small badge inside source message card; source replaces target (CORRECT)
  | 'inline-badge'      // Small inline badge on target message
  | 'proposal-card'     // Governance proposal card with vote/settlement lifecycle
  | 'code-card';        // Code change proposal card with vote/deploy lifecycle

export interface PresentationSpec {
  /** How this relation is rendered */
  kind: PresentationKind;
  /** Display label (Chinese) */
  label: string;
  /**
   * Tailwind color name (without prefix), e.g. 'blue', 'green', 'red'.
   * Used to derive bg-{color}-100, text-{color}-700, border-{color}-400, etc.
   */
  color: string;
  /** Whether this relation type counts as a positive/negative stance vote */
  stanceEffect?: 'support' | 'oppose';
  /**
   * Whether this relation type participates in building the tree view.
   * Tree-forming relations make the source message a "child" of the target.
   */
  formsTrees?: boolean;
  /**
   * True for arrange-frame and frame-group types.
   * These relations cluster all their target messages into the same column
   * and wrap them in a visible border frame.
   * Layout pipeline: target messages are stacked with zero gap (same column).
   */
  groupsTargets?: boolean;
  /**
   * True for replace-overlay types (SUMMARY) and correction-badge types (CORRECT).
   * The source message visually replaces / covers the target message(s) in the
   * non-linear view.  The source is still placed in the same column as the
   * target (same-column stacking, like arrange), but is presented as the
   * authoritative content with the original dimmed or accessible via double-click.
   */
  replacesTarget?: boolean;
  /**
   * True for container-type relations (CLASSIFY, MERGE, SUMMARY).
   * Container relations group messages but do NOT count as focus-distance hops.
   * In focus mode, container cards appear at the hop distance of their nearest
   * connected message; their children are expanded at that distance + 1.
   */
  isContainer?: boolean;
}

/**
 * Central registry mapping relation type strings to their presentation spec.
 * To add a new relation type, add an entry here — no GraphView changes needed.
 */
export const PRESENTATION_SPECS: Record<string, PresentationSpec> = {
  ANNOTATION:  { kind: 'edge-label',        label: '注释', color: 'blue',   formsTrees: false },
  REFERENCE:   { kind: 'edge-label',        label: '引用', color: 'indigo', formsTrees: false },
  REPLY:       { kind: 'edge-label',        label: '回复', color: 'blue',   formsTrees: true  },
  AGREE:       { kind: 'decoration',        label: '赞同', color: 'green',  stanceEffect: 'support' },
  DISAGREE:    { kind: 'decoration',        label: '反对', color: 'red',    stanceEffect: 'oppose'  },
  TAG:         { kind: 'decoration-label',  label: '标注', color: 'yellow', formsTrees: false },
  CORRECT:     { kind: 'correction-badge',  label: '更正', color: 'yellow', formsTrees: true,  replacesTarget: true  },
  ARRANGE:     { kind: 'arrange-frame',     label: '排列', color: 'purple', formsTrees: true,  groupsTargets: true   },
  CLASSIFY:    { kind: 'frame-group',       label: '分类', color: 'gray',   formsTrees: false, groupsTargets: true,   isContainer: true  },
  MERGE:       { kind: 'frame-group',       label: '归并', color: 'gray',   formsTrees: false, groupsTargets: true,   isContainer: true  },
  SUMMARY:     { kind: 'replace-overlay',   label: '总结', color: 'amber',  formsTrees: false, replacesTarget: true, groupsTargets: true, isContainer: true  },
  RECOMMEND:   { kind: 'inline-badge',      label: '推荐', color: 'orange', formsTrees: false },
  ARCHIVE:     { kind: 'inline-badge',      label: '冷藏', color: 'slate',  formsTrees: false },
  PROPOSAL:    { kind: 'edge-label',        label: '🏛️ 提案', color: 'amber',  formsTrees: false },
  CODE_CHANGE: { kind: 'edge-label',        label: '💻 代码', color: 'teal',  formsTrees: false },
  OPERATIONS:  { kind: 'edge-label',        label: '📊 运营', color: 'cyan',   formsTrees: false },
};

/** Get the presentation spec for a relation type, with a sensible default.
 * Accepts both UPPERCASE (backend/canonical) and lowercase (bridge/internal) keys. */
export function getPresentationSpec(relationType: string): PresentationSpec {
  return (
    PRESENTATION_SPECS[relationType] ??
    PRESENTATION_SPECS[relationType.toUpperCase()] ??
    {
      kind: 'edge-label',
      label: relationType,
      color: 'gray',
      formsTrees: false,
    }
  );
}

// ============================================================
// Graph / View Model
// ============================================================

/** Stance statistics for a message (support/oppose counts) */
export interface StanceStats {
  support: number;
  oppose: number;
}

/**
 * A node in the message tree view.
 * Relations with formsTrees=true cause the source message to appear
 * as a child node under the target message.
 */
export interface MessageNode {
  message: Message;
  /** The relation type that connected this node to its parent */
  relationType?: RelationType;
  relationId?: string;
  children: MessageNode[];
}

// ============================================================
// Helper Utilities for TargetRef
// ============================================================

/** Extract all message IDs that a TargetRef array points to */
export function getTargetMessageIds(targetRefs: TargetRef[]): string[] {
  return targetRefs
    .filter((r): r is Extract<TargetRef, { kind: 'message' | 'text-fragment' }> =>
      r.kind === 'message' || r.kind === 'text-fragment',
    )
    .map(r => r.messageId);
}

/** Extract all relation IDs that a TargetRef array points to */
export function getTargetRelationIds(targetRefs: TargetRef[]): string[] {
  return targetRefs
    .filter((r): r is Extract<TargetRef, { kind: 'relation' }> => r.kind === 'relation')
    .map(r => r.relationId);
}

export function getRelationLabel(payload: RelationPayload | undefined): string | undefined {
  return payload?.label?.trim() || undefined;
}

export function getRelationTitle(payload: RelationPayload | undefined): string | undefined {
  return payload?.title?.trim() || payload?.content?.trim() || undefined;
}

export function getRelationTargetLayout(relation: Pick<Relation, 'relationType' | 'payload'>): RelationTargetLayout {
  if (relation.payload?.targetLayout) return relation.payload.targetLayout;
  const type = relation.relationType.toUpperCase();
  return (type === 'MERGE' || type === 'SUMMARY') ? 'multi-column' : 'single-column';
}

// ============================================================
// Draft / Selection Types
// ============================================================

/**
 * A selectable unit in the draft/sources/targets system.
 * Discriminated union to support text messages, text fragments, and relation messages.
 */
export type DraftItem =
  | { type: 'message'; id: string }
  | { type: 'text-fragment'; messageId: string; text: string; hash: string }
  | { type: 'relation'; id: string; part?: 'label' | 'decoration' | 'frame' | 'whole' };

// ============================================================
// Pagination
// ============================================================

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ============================================================
// Tailwind Color Utilities (derived from PresentationSpec)
// ============================================================

/** Get the Tailwind border color class for a relation type's connector line */
export function getConnectorColorClass(relationType: string): string {
  const spec = getPresentationSpec(relationType);
  const COLOR_BORDER: Record<string, string> = {
    blue:   'border-blue-400',
    indigo: 'border-indigo-400',
    green:  'border-green-400',
    red:    'border-red-400',
    yellow: 'border-yellow-400',
    purple: 'border-purple-400',
    orange: 'border-orange-400',
    amber:  'border-amber-400',
    gray:   'border-gray-300',
    slate:  'border-slate-300',
  };
  return COLOR_BORDER[spec.color] ?? 'border-gray-300';
}

// ============================================================
// Points & Ledger Types (Phase 1)
// ============================================================

export interface PointsBalance {
  points: {
    available: number;
    locked: number;
  };
  balance: {
    amount: number;
    debtFrozen: boolean;
  };
  breakdown: {
    initialMinted: number;
    totalEarned: number;   // 收益（结算成功）
    totalLost: number;     // 损失（结算失败）
    totalBurned: number;   // 燃烧（手续费）
  };
}

export interface PointTransaction {
  id: string;
  type: string; // MINT | UNLOCK | LOCK | SPEND | TRANSFER
  amount: number;
  balanceAfter: number;
  createdAt: string;
  data?: Record<string, unknown> | null;
}

export interface CurrentRule {
  id: string;
  version: number;
  status: string;
  description: string | null;
  parameters: Record<string, unknown>;
  createdAt: string;
}

// ============================================================
// Stake & BetPool Types (Phase 2)
// ============================================================

export interface StakeResult {
  message: string;
  stakeId: string;
  side: 'PRO' | 'CON';
  amount: number;
  newAvailable: number;
  newLocked: number;
  newBalance: number;
}

export interface StakeItem {
  id: string;
  side: 'PRO' | 'CON';
  amount: number;
  createdAt: string;
  roundId?: string | null;
  user: User;
}

export interface MessageStakes {
  messageId: string;
  pool: {
    lockedPro: number;
    lockedCon: number;
  };
  stakes: StakeItem[];
  counts: {
    pro: number;
    con: number;
  };
}

// ============================================================
// Settlement Types (Phase 3)
// ============================================================

export interface VoteStakeItem {
  id: string;
  vote: 'TRUE' | 'FALSE';
  amount: number;
  createdAt: string;
  user: User;
}

export interface SettlementRoundItem {
  id: string;
  roundMessageId?: string;
  messageId: string;
  createdByUserId: string;
  createdBy: User;
  status: 'OPEN' | 'VOTING' | 'SETTLED' | 'CANCELLED';
  settlementType: 'TRUTH' | 'VALUE';
  result: 'TRUE' | 'FALSE' | 'UNKNOWN' | null;
  previousRoundId: string | null;
  openedAt: string;
  closedAt: string | null;
  note: string | null;
  votes?: VoteStakeItem[];
  _count?: { votes: number };
  weights?: { TRUE: number; FALSE: number; UNKNOWN: number };
}

export interface SettlementResult {
  message: string;
  roundId: string;
  messageId: string;
  result: 'TRUE' | 'FALSE' | 'UNKNOWN';
  weights: { TRUE: number; FALSE: number; UNKNOWN: number };
  totalPro: number;
  totalCon: number;
  affectedUsers: number;
}

export interface VoteCastResult {
  message: string;
  voteId: string;
  vote: 'TRUE' | 'FALSE';
  amount: number;
  newAvailable: number;
  newLocked: number;
  newBalance: number;
}

// ============================================================
// Stance Types (Phase 5)
// ============================================================

export interface StanceRelation {
  kind: 'relation';
  id: string;
  relationMessageId: string;
  topicId: string;
  topicTitle: string;
  type: string;      // AGREE | DISAGREE | SELF_AGREE
  amount: number;
  stakeId?: string | null;
  targetMessageId: string | null;
  content: string | null;
  createdAt: string;
}

export interface StanceStake {
  kind: 'stake';
  id: string;
  topicId: string;
  topicTitle: string;
  messageId: string;
  content: string;
  amount: number;
  createdAt: string;
}

export interface StanceTag {
  kind: 'tag';
  id: string;
  relationMessageId: string;
  topicId: string;
  topicTitle: string;
  relationType: string;  // TAG | RECOMMEND | ARCHIVE
  label: string;
  subType: string | null;      // SPAM | OFFTOPIC | LOWVALUE | IMPORTANT | CUSTOM
  customLabel: string | null;
  targetMessageId: string | null;
  stakeId?: string | null;
  amount: number;
  createdAt: string;
}

export interface StanceHistoryResponse {
  user: { id: string };
  stances: {
    relations: StanceRelation[];
    stakes: StanceStake[];
    tags: StanceTag[];
  };
  pagination: {
    page: number;
    limit: number;
    totalRelations: number;
    totalStakes: number;
    totalTags: number;
  };
}

// ============================================================
// Phase 6: Clean View Filter Rules
// ============================================================

/**
 * 清爽视图过滤器规则 — 可组合的多维过滤条件。
 * 每条规则是一个独立判断函数，所有规则之间为 AND 关系。
 * 用户可以自由组合规则来投影消息图的不同切片。
 */
export type CleanFilterRule =
  | { id: string; kind: 'sender'; username: string }
  | { id: string; kind: 'tag'; tagType: string; minCount: number }
  | { id: string; kind: 'stake'; minAmount: number; side?: 'PRO' | 'CON' }
  | { id: string; kind: 'rounds'; minRounds: number }
  | { id: string; kind: 'participants'; minCount: number }
  | { id: string; kind: 'relationType'; relationType: string };

/** 过滤器规则中文标签 */
export const CLEAN_FILTER_LABELS: Record<CleanFilterRule['kind'], string> = {
  sender:       '按发送者',
  tag:          '按标签',
  stake:        '按押注额度',
  rounds:       '按结算轮次',
  participants: '按站队人数',
  relationType: '按关系类型',
};

/** 过滤器规则默认值 */
export function defaultCleanRule(kind: CleanFilterRule['kind']): CleanFilterRule {
  const id = `cf_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  switch (kind) {
    case 'sender':       return { id, kind: 'sender', username: '' };
    case 'tag':          return { id, kind: 'tag', tagType: 'ARCHIVE', minCount: 5 };
    case 'stake':        return { id, kind: 'stake', minAmount: 50 };
    case 'rounds':       return { id, kind: 'rounds', minRounds: 2 };
    case 'participants': return { id, kind: 'participants', minCount: 8 };
    case 'relationType': return { id, kind: 'relationType', relationType: 'OPERATIONS' };
  }
}

// ============================================================
// Phase 6: Audit Log, Revenue & Governance Types
// ============================================================

export interface AuditLogEntry {
  id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  topicId: string | null;
  createdAt: string;
  data?: Record<string, unknown> | null;
  actor?: { id: string; username: string } | null;
}

export interface RevenuePoolData {
  id: string;
  totalReceived: number;
  totalDistributed: number;
  balance: number;
  updatedAt: string;
}

export interface RevenueDistributionItem {
  id: string;
  userId: string;
  user: { id: string; username: string };
  amount: number;
  createdAt: string;
}
