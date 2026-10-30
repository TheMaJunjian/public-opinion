import type { Part, Reference, ExecutedStance, Json, MessageState, Message as CoreMessage } from './types.js';

/** Shared transport views. Partial and provisional projections may omit native execution fields. */
export interface UserView {
  id: string;
  username: string;
  createdAt: string;
}

export interface ScopeView {
  messageId: string | null;
  title: string;
}

export interface MessageView {
  id: string;
  sequence?: number;
  revision?: number;
  parts?: Part[];
  executedStance?: ExecutedStance;
  state?: MessageState;
  spending?: CoreMessage['spending'];
  kind: string;
  contentType: 'TEXT' | 'MARKDOWN';
  content: string;
  createdAt: string;
  updatedAt?: string;
  supersededBy?: string | null;
  createdBy: UserView;
  relationType?: RelationType | null;
  relSourceId?: string | null;
  targetRefs?: TargetRef[];
  declaredTargetRefs?:TargetRef[];
  relationPayload?: RelationPayload | null;
}

export type RelationType =
  | 'ANNOTATION'   // 注释
  | 'REFERENCE'    // 引用
  | 'REPLY'        // 回复
  | 'AGREE'        // 赞同（有文本时视为支持）
  | 'DISAGREE'     // 反对（有文本时视为反驳）
  | 'TAG'          // 标注（消息旁的装饰标签）
  | 'READ'         // 已读标注
  | 'UNREAD'       // 未读标注
  | 'NOTIFY'       // 回复通知
  | 'CORRECT'      // 更正
  | 'ARRANGE'      // 排列（边框包裹目标消息；payload.targetLayout 控制横/纵排列）
  | 'CLASSIFY'     // 分类
  | 'MERGE'        // 归并
  | 'SUMMARY'      // 总结
  | 'RECOMMEND'    // 推荐
  | 'ARCHIVE'      // 冷藏
  | 'ATTENTION'    // 关注
  | 'BLOCK'        // 拉黑
  | 'OPERATIONS'   // 运营（收入、统计等程序运营信息）
  | 'DELEGATION'   // 委托（押注作为完成委托的报酬）
  | 'JOIN'         // 加入（内部成员关系记录）
  | string;

export type TargetRef = ({ reference?: Reference } & (
  | { kind: 'message'; messageId: string }
  | {
      kind: 'text-fragment';
      messageId: string;
      text: string;
      hash: string;
    }
  | {
      kind: 'relation';
      relationId: string;
      /** Which selectable part of the relation is targeted */
      part?: 'label' | 'decoration' | 'frame' | 'whole';
    }));

export type RelationTargetLayout = 'single-column' | 'multi-column' | 'single-row';

export interface RelationPayload {
  independentMemberships?: boolean;
  membershipHistory?: import('./membership.js').MembershipAction;
  label?: string;
  annotationStance?: { target: Reference; side: 'pro' | 'con' };
  repetitionCount?:number;
  title?: string;
  targetLayout?: RelationTargetLayout;
  content?: string;
  subType?: 'SPAM' | 'OFFTOPIC' | 'LOWVALUE' | 'IMPORTANT' | 'CUSTOM' | 'YES' | 'NO';
  customLabel?: string;
  operationType?: string;
  /** Settlement declaration provenance; the public author may be the system. */
  openedBy?: string;
  triggerId?: string;
  subjectId?: string;
  amount?: number;
  revenuePoolShare?: number;
  recipientUserId?: string;
  source?: string;
  note?: string;
  attentionUserIds?: string[];
  notifyUserIds?: string[];
  notifyUsers?: Array<{ id: string; username: string }>;
  delegationKind?: 'CREATE' | 'FULFILL';
  rewardAmount?: number;
  rewardRatio?: number;
  /** CORRECT stores the complete replacement content directly on the correction relation. */
  correctionContent?: string;
  correctionValue?: Json;
  correctionKind?: 'TEXT' | 'MEANING' | 'WIDTH';
  /** Requested graph card width in canvas CSS pixels; independent of body edits. */
  correctionWidth?: number;
  /** Full readable content around a suggested text edit, for comparison only. */
  correctionBeforeContent?: string;
  correctionAfterContent?: string;
  /** Display fingerprints on an explicitly sent READ annotation; no separate system messages. */
  readDisplay?: Record<string,string>;
  readDisplayParts?: Record<string,{ message: string; corrections?: string }>;
  /** Meaning corrections present in the body when this stance was sent. Text edits share votes. */
  stanceCorrections?: Record<string,string[]>;
}

export interface RelationView {
  id: string;
  sequence?: number;
  revision?: number;
  parts?: Part[];
  sourceRefs?: Reference[];
  executedStance?: ExecutedStance;
  state?: MessageState;
  spending?: CoreMessage['spending'];
  relationType: RelationType;
  /**
   * ID of the text message that "sends" / authors this relation.
   * Nullable for AGREE/DISAGREE pure-stance relations (no attached text message).
   * Also null for TAG and MERGE relations (user-to-message relations).
   */
  sourceMessageId: string | null;
  targetRefs: TargetRef[];
  declaredTargetRefs?:TargetRef[];
  payload?: RelationPayload;
  createdAt: string;
  createdBy: UserView;
}

export interface StakeItem {
  id: string;
  side: 'PRO' | 'CON';
  amount: number;
  createdAt: string;
  roundId?: string | null;
  settlementType?: 'TRUTH' | 'VALUE';
  user: UserView;
  reference?: Reference;
}

export interface MessageStakes {
  contexts?: Record<string,Omit<MessageStakes,'contexts'>>;
  messageId: string;
  pool: {
    lockedPro: number;
    lockedCon: number;
  };
  /** Per-settlementType BetPool breakdown (current round, not cumulative) */
  pools?: Record<string, { lockedPro: number; lockedCon: number }>;
  stakes: StakeItem[];
  counts: {
    pro: number;
    con: number;
  };
  /** Per-settlementType cumulative stake counts */
  countsByType?: Record<string, { pro: number; con: number }>;
}

export interface PersonalState { messageId: string; read: boolean; followed: boolean; blocked: boolean; archived: boolean }

/** Native responses always carry the authoritative execution fields. */
export interface NativeMessageView extends MessageView {
  sequence: number; revision: number; parts: Part[]; updatedAt: string;
  spending: CoreMessage['spending']; state: MessageState;
  sourceMessageId: string | null; sourceRefs: Reference[]; targetRefs: TargetRef[]; payload: RelationPayload;
}
export interface NativeMessageStakes extends MessageStakes {
  pools: NonNullable<MessageStakes['pools']>;
  countsByType: NonNullable<MessageStakes['countsByType']>;
}

export function isRelationView(view: NativeMessageView): view is NativeMessageView & RelationView {
  return typeof view.relationType === 'string' && view.relationType.length > 0;
}

export interface WorkbenchSnapshot {
  regionId?: string;
  windowed?: boolean;
  scope: ScopeView;
  messages: MessageView[];
  relations: RelationView[];
  users: UserView[];
  stakes: Record<string, MessageStakes>;
  tagCounts: Record<string, Record<string, number>>;
  attentionUsers: Record<string, string[]>;
  personalStates?: PersonalState[];
  sequence: number;
  nextCursor?: string | null;
  pageCursors?: Record<string, string | null>;
  hasMore?: boolean;
  removedMessageIds?: string[];
  removedMemberships?: string[];
}
/** Private viewing progress. These records are never public messages or investments. */
export interface ReadingMark {
  firstConfirmedAt?:string;
  baselineSequence?:number;
  originalSeen?:true;
  unknownContext?: true;
  format?: 2|3;
  position?: number;
  version?: import('./types.js').BodyVersion;
  eventId?: string;
  resultKey?: string;
  state?: 'READ' | 'UNREAD';
  selection?: {versionKey:string;outcomes:Record<string,string>;signature:string};
  messageId: string;
  scope: 'message' | 'corrections' | 'influence' | 'original' | 'comparison';
  key: string;
  signature?: string;
  bodySignature?: string;
  confirmation?: {kind:'direct'|'included';messageId:string};
  /** Server-maintained evidence survives later included confirmations. */
  directConfirmedAt?: string;
  legacyConfirmation?: true;
  updatedAt?: string;
}
