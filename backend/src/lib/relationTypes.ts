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
 * This is the backend's canonical list for API validation.
 * Presentation metadata (display label, color, edge kind, stance effect, formsTrees)
 * lives exclusively in the frontend's PRESENTATION_SPECS registry:
 *   frontend/src/types/index.ts → PRESENTATION_SPECS
 *
 * When adding a new relation type:
 *   1. Append the type string to this array (backend validation).
 *   2. Add a matching entry in PRESENTATION_SPECS (frontend rendering).
 *   No DB migration required — the relationType column is plain TEXT.
 */
export const RELATION_TYPES = [
  'ANNOTATION',   // 注释
  'REFERENCE',    // 引用
  'REPLY',        // 回复
  'AGREE',        // 赞同
  'DISAGREE',     // 反对
  'SUPPORT',      // 支持（含立场表达）
  'REBUT',        // 反驳
  'CORRECT',      // 更正
  'SUPPLEMENT',   // 补充
  'CLASSIFY',     // 分类
  'MERGE',        // 归并
  'SUMMARY',      // 总结
  'RECOMMEND',    // 推荐
  'ARCHIVE',      // 冷藏
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
