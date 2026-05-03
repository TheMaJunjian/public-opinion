/**
 * relationTypes.ts — Centralized relation type registry for the backend.
 *
 * All supported relation types are defined here.
 * To add a new relation type:
 *   1. Append the new type string to RELATION_TYPES below.
 *   2. Update the frontend's PRESENTATION_SPECS in frontend/src/types/index.ts.
 *   3. No DB migration needed (relationType column is TEXT).
 *
 * The DB column intentionally uses TEXT (not an enum) so that new types
 * can be added without a migration. Validation happens at the API layer.
 */

/**
 * All currently supported relation types.
 *
 * Types by presentation category:
 *   Edge-label (directed connector): ANNOTATION, REFERENCE, REPLY, SUPPLEMENT
 *   Decoration (badge on target):    AGREE, DISAGREE
 *   Edge + Decoration:               SUPPORT, REBUT
 *   Replace/Overlay:                 CORRECT, SUMMARY
 *   Frame/Group:                     CLASSIFY, MERGE
 *   Inline badge:                    RECOMMEND, ARCHIVE
 */
export const RELATION_TYPES = [
  'ANNOTATION',   // 注释 — edge-label, blue
  'REFERENCE',    // 引用 — edge-label, indigo
  'REPLY',        // 回复 — edge-label, blue, formsTrees
  'AGREE',        // 赞同 — decoration, green, stanceEffect=support
  'DISAGREE',     // 反对 — decoration, red, stanceEffect=oppose
  'SUPPORT',      // 支持 — edge-decoration, green, formsTrees, stanceEffect=support
  'REBUT',        // 反驳 — edge-decoration, red, formsTrees, stanceEffect=oppose
  'CORRECT',      // 更正 — replace-overlay, yellow, formsTrees
  'SUPPLEMENT',   // 补充 — edge-label, purple, formsTrees
  'CLASSIFY',     // 分类 — frame-group, gray
  'MERGE',        // 归并 — frame-group, gray
  'SUMMARY',      // 总结 — replace-overlay, amber
  'RECOMMEND',    // 推荐 — inline-badge, orange
  'ARCHIVE',      // 冷藏 — inline-badge, slate
] as const;

/** The union type of all known relation types (for TypeScript type safety) */
export type KnownRelationType = (typeof RELATION_TYPES)[number];

/**
 * Check whether a string is a known relation type.
 * Use this for runtime validation outside of Zod schemas.
 */
export function isKnownRelationType(value: string): value is KnownRelationType {
  return (RELATION_TYPES as readonly string[]).includes(value);
}
