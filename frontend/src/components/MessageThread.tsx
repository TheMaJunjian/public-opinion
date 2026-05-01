/**
 * MessageThread.tsx — Recursive component for the non-linear tree view.
 *
 * Renders a message node and its children, with indented connector lines
 * and relation type badges. The connector color is driven by PresentationSpec.
 */

import type { MessageNode, StanceStats } from '../types';
import { getConnectorColorClass } from '../types';
import MessageCard from './MessageCard';
import RelationBadge from './RelationBadge';

interface Props {
  node: MessageNode;
  topicId: string;
  stanceStatsMap: Map<string, StanceStats>;
  depth?: number;
}

const INDENT_COLORS = [
  'border-gray-300',
  'border-blue-300',
  'border-purple-300',
  'border-indigo-300',
];

export default function MessageThread({ node, topicId, stanceStatsMap, depth = 0 }: Props) {
  const stanceStats = stanceStatsMap.get(node.message.id);
  const indentColor = INDENT_COLORS[depth % INDENT_COLORS.length];
  const connectorColor = node.relationType ? getConnectorColorClass(node.relationType) : indentColor;

  return (
    <div className={depth > 0 ? 'relative pl-6 mt-2' : ''}>
      {/* Vertical connector line (child nodes only) */}
      {depth > 0 && (
        <div className={`absolute left-0 top-0 bottom-0 w-px border-l-2 ${connectorColor}`} />
      )}

      {/* Relation type badge (child nodes only) */}
      {node.relationType && depth > 0 && (
        <div className="flex items-center gap-2 mb-1.5">
          <div className={`w-4 h-px border-t-2 ${connectorColor}`} />
          <RelationBadge type={node.relationType} />
        </div>
      )}

      {/* Message card */}
      <MessageCard
        message={node.message}
        topicId={topicId}
        relationType={depth > 0 ? node.relationType : undefined}
        stanceStats={stanceStats}
      />

      {/* Children: recursive */}
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

