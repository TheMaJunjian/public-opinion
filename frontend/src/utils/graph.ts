/**
 * graph.ts — 非线性表结构工具函数
 *
 * 公论的核心理念：消息是节点；消息的关系也是消息。
 * 这里提供将"线性消息列表 + 关系列表"转换为可渲染树的算法，
 * 以及计算每条消息的"立场统计"（支持/反对数量）的工具。
 */

import type { Message, Relation, MessageNode, StanceStats } from '../types';

/** 这些关系类型会形成树结构（子→父） */
const TREE_RELATION_TYPES = new Set(['REPLY', 'SUPPORT', 'OPPOSE', 'CORRECT']);

/**
 * buildMessageTree — 将消息列表与关系列表转换为非线性树结构
 *
 * 规则：
 *   sourceMessageId 是"子"（作出回应的消息）
 *   targetRef.targetMessageId 是"父"（被回应的消息）
 *
 * 根节点：没有任何"树型关系"父节点的消息
 * 子节点：通过 REPLY/SUPPORT/OPPOSE/CORRECT 关系指向另一条消息的消息
 */
export function buildMessageTree(messages: Message[], relations: Relation[]): MessageNode[] {
  // 只取树型关系
  const treeRels = relations.filter(r => TREE_RELATION_TYPES.has(r.relationType));

  // childId → {parentId, relationType, relationId}
  // 若一条消息同时回应多条（多 targetRefs），取第一条作为"主父"
  const childParentMap = new Map<string, { parentId: string; relationType: string; relationId: string }>();

  for (const rel of treeRels) {
    if (!childParentMap.has(rel.sourceMessageId) && rel.targetRefs.length > 0) {
      childParentMap.set(rel.sourceMessageId, {
        parentId: rel.targetRefs[0].targetMessageId,
        relationType: rel.relationType,
        relationId: rel.id,
      });
    }
  }

  // parentId → 子节点列表（含关系信息）
  const childrenMap = new Map<string, MessageNode[]>();
  for (const [childId, info] of childParentMap.entries()) {
    const msg = messages.find(m => m.id === childId);
    if (!msg) continue;
    const siblings = childrenMap.get(info.parentId) ?? [];
    siblings.push({ message: msg, relationType: info.relationType, relationId: info.relationId, children: [] });
    childrenMap.set(info.parentId, siblings);
  }

  // 递归构建节点（填充 children）
  function buildNode(msg: Message, relationType?: string, relationId?: string): MessageNode {
    const rawChildren = childrenMap.get(msg.id) ?? [];
    return {
      message: msg,
      relationType,
      relationId,
      children: rawChildren.map(c => buildNode(c.message, c.relationType, c.relationId)),
    };
  }

  // 根节点：未出现在任何子→父映射的消息
  const rootMessages = messages.filter(m => !childParentMap.has(m.id));
  return rootMessages.map(m => buildNode(m));
}

/**
 * computeStanceStats — 计算每条消息的"立场统计"（支持/反对数）
 *
 * 统计规则：
 *   当某条关系 relationType=SUPPORT 且 targetRef.targetMessageId=X 时，X 的 support++
 *   当 relationType=OPPOSE 时，X 的 oppose++
 */
export function computeStanceStats(messages: Message[], relations: Relation[]): Map<string, StanceStats> {
  const statsMap = new Map<string, StanceStats>();
  for (const msg of messages) {
    statsMap.set(msg.id, { support: 0, oppose: 0 });
  }

  for (const rel of relations) {
    for (const ref of rel.targetRefs) {
      const stats = statsMap.get(ref.targetMessageId);
      if (!stats) continue;
      if (rel.relationType === 'SUPPORT') stats.support++;
      else if (rel.relationType === 'OPPOSE') stats.oppose++;
    }
  }

  return statsMap;
}
