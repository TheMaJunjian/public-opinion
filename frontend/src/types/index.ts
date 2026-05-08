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
 *   Supplement-frame (border wrap):  SUPPLEMENT
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
  | 'SUPPLEMENT'   // 补充（边框包裹目标+来源消息）
  | 'CLASSIFY'     // 分类
  | 'MERGE'        // 归并
  | 'SUMMARY'      // 总结
  | 'RECOMMEND'    // 推荐
  | 'ARCHIVE'      // 冷藏
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
  /**
   * Label text for TAG relations. Stored directly on the relation instead of a source message.
   * Undefined for all non-TAG relation types.
   */
  tagLabel?: string;
  /**
   * Topic title for CLASSIFY relations. Stored directly on the relation.
   * Undefined for all non-CLASSIFY relation types.
   */
  classifyTitle?: string;
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
  | 'supplement-frame'  // Border frame wrapping target + source messages (source below target)
  | 'frame-group'       // Frames a group of messages
  | 'replace-overlay'   // Overlays / replaces the target message display (e.g. SUMMARY)
  | 'correction-badge'  // Small badge inside source message card; source replaces target (CORRECT)
  | 'inline-badge';     // Small inline badge on target message

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
   * True for supplement-frame and frame-group types.
   * These relations cluster all their target messages into the same column
   * and wrap them in a visible border frame.
   * Layout pipeline: target messages are stacked with zero gap (same column).
   */
  groupsTargets?: boolean;
  /**
   * True for replace-overlay types (SUMMARY) and correction-badge types (CORRECT).
   * The source message visually replaces / covers the target message(s) in the
   * non-linear view.  The source is still placed in the same column as the
   * target (same-column stacking, like supplement), but is presented as the
   * authoritative content with the original dimmed or accessible via double-click.
   */
  replacesTarget?: boolean;
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
  SUPPLEMENT:  { kind: 'supplement-frame',  label: '补充', color: 'purple', formsTrees: true,  groupsTargets: true   },
  CLASSIFY:    { kind: 'frame-group',       label: '分类', color: 'gray',   formsTrees: false, groupsTargets: true   },
  MERGE:       { kind: 'frame-group',       label: '归并', color: 'gray',   formsTrees: false, groupsTargets: true   },
  SUMMARY:     { kind: 'replace-overlay',   label: '总结', color: 'amber',  formsTrees: false, groupsTargets: true, replacesTarget: true },
  RECOMMEND:   { kind: 'inline-badge',      label: '推荐', color: 'orange', formsTrees: false },
  ARCHIVE:     { kind: 'inline-badge',      label: '冷藏', color: 'slate',  formsTrees: false },
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
