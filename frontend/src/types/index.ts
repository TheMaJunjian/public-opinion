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
  _count?: { messages: number; relations?: number };
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
 *   Edge-label (directed connector): ANNOTATION, REFERENCE, REPLY, SUPPLEMENT
 *   Decoration (badge on target):    AGREE, DISAGREE
 *   Edge + Decoration:               SUPPORT, REBUT
 *   Replace/Overlay:                 CORRECT, SUMMARY
 *   Frame/Group:                     CLASSIFY, MERGE
 *   Inline badge:                    RECOMMEND, ARCHIVE
 */
export type RelationType =
  | 'ANNOTATION'   // 注释
  | 'REFERENCE'    // 引用
  | 'REPLY'        // 回复
  | 'AGREE'        // 赞同
  | 'DISAGREE'     // 反对
  | 'SUPPORT'      // 支持（立场表达 + 连接）
  | 'REBUT'        // 反驳（立场表达 + 连接）
  | 'CORRECT'      // 更正
  | 'SUPPLEMENT'   // 补充
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
  /** ID of the text message that "sends" / authors this relation */
  sourceMessageId: string;
  targetRefs: TargetRef[];
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
  | 'edge-label'      // Directed connector with a clickable label
  | 'decoration'      // Badge/decoration attached to target message card
  | 'edge-decoration' // Directed connector AND badge on target
  | 'frame-group'     // Frames a group of messages
  | 'replace-overlay' // Overlays / replaces the target message display
  | 'inline-badge';   // Small inline badge on target message

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
}

/**
 * Central registry mapping relation type strings to their presentation spec.
 * To add a new relation type, add an entry here — no GraphView changes needed.
 */
export const PRESENTATION_SPECS: Record<string, PresentationSpec> = {
  ANNOTATION:  { kind: 'edge-label',      label: '注释', color: 'blue',   formsTrees: false },
  REFERENCE:   { kind: 'edge-label',      label: '引用', color: 'indigo', formsTrees: false },
  REPLY:       { kind: 'edge-label',      label: '回复', color: 'blue',   formsTrees: true  },
  AGREE:       { kind: 'decoration',      label: '赞同', color: 'green',  stanceEffect: 'support' },
  DISAGREE:    { kind: 'decoration',      label: '反对', color: 'red',    stanceEffect: 'oppose'  },
  SUPPORT:     { kind: 'edge-decoration', label: '支持', color: 'green',  stanceEffect: 'support', formsTrees: true },
  REBUT:       { kind: 'edge-decoration', label: '反驳', color: 'red',    stanceEffect: 'oppose',  formsTrees: true },
  CORRECT:     { kind: 'replace-overlay', label: '更正', color: 'yellow', formsTrees: true  },
  SUPPLEMENT:  { kind: 'edge-label',      label: '补充', color: 'purple', formsTrees: true  },
  CLASSIFY:    { kind: 'frame-group',     label: '分类', color: 'gray',   formsTrees: false },
  MERGE:       { kind: 'frame-group',     label: '归并', color: 'gray',   formsTrees: false },
  SUMMARY:     { kind: 'replace-overlay', label: '总结', color: 'amber',  formsTrees: false },
  RECOMMEND:   { kind: 'inline-badge',    label: '推荐', color: 'orange', formsTrees: false },
  ARCHIVE:     { kind: 'inline-badge',    label: '冷藏', color: 'slate',  formsTrees: false },
};

/** Get the presentation spec for a relation type, with a sensible default */
export function getPresentationSpec(relationType: string): PresentationSpec {
  return (
    PRESENTATION_SPECS[relationType] ?? {
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
