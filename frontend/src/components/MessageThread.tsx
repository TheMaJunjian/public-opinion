/**
 * MessageThread.tsx — 非线性树视图的递归节点组件
 *
 * 渲染一个消息节点及其子节点（通过 REPLY/SUPPORT/OPPOSE/CORRECT 关系形成的树）。
 * 通过缩进与彩色连接线体现非线性讨论结构。
 */

import type { MessageNode, StanceStats } from '../types';
import MessageCard from './MessageCard';
import RelationBadge from './RelationBadge';

interface Props {
  node: MessageNode;
  topicId: string;
  stanceStatsMap: Map<string, StanceStats>;
  /** 当前缩进层级，根节点为 0 */
  depth?: number;
}

/** 不同层级的缩进颜色，循环使用 */
const INDENT_COLORS = [
  'border-gray-300',
  'border-blue-300',
  'border-purple-300',
  'border-indigo-300',
];

/** 关系类型对应的连接线颜色 */
const CONNECTOR_COLOR: Record<string, string> = {
  SUPPORT: 'border-green-400',
  OPPOSE:  'border-red-400',
  CORRECT: 'border-yellow-400',
  REPLY:   'border-blue-400',
  QUOTE:   'border-indigo-300',
};

export default function MessageThread({ node, topicId, stanceStatsMap, depth = 0 }: Props) {
  const stanceStats = stanceStatsMap.get(node.message.id);
  const indentColor = INDENT_COLORS[depth % INDENT_COLORS.length];

  return (
    <div className={depth > 0 ? 'relative pl-6 mt-2' : ''}>
      {/* 垂直连接线：仅在子节点绘制 */}
      {depth > 0 && (
        <div
          className={`absolute left-0 top-0 bottom-0 w-px border-l-2 ${
            node.relationType ? CONNECTOR_COLOR[node.relationType] ?? indentColor : indentColor
          }`}
        />
      )}

      {/* 关系类型标签（仅子节点显示） */}
      {node.relationType && depth > 0 && (
        <div className="flex items-center gap-2 mb-1.5">
          <div
            className={`w-4 h-px border-t-2 ${
              CONNECTOR_COLOR[node.relationType] ?? 'border-gray-300'
            }`}
          />
          <RelationBadge type={node.relationType} />
        </div>
      )}

      {/* 消息卡片 */}
      <MessageCard
        message={node.message}
        topicId={topicId}
        relationType={depth > 0 ? node.relationType : undefined}
        stanceStats={stanceStats}
      />

      {/* 子节点：递归渲染 */}
      {node.children.length > 0 && (
        <div className="mt-1 space-y-1">
          {node.children.map(child => (
            <MessageThread
              key={child.message.id}
              node={child}
              topicId={topicId}
              stanceStatsMap={stanceStatsMap}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
