import { Link } from 'react-router-dom';
import type { Message, StanceStats } from '../types';
import { getConnectorColorClass } from '../types';

interface Props {
  message: Message;
  topicId: string;
  highlighted?: boolean;
  /** Relation type that connected this card to its parent in the tree */
  relationType?: string;
  stanceStats?: StanceStats;
}

export default function MessageCard({
  message,
  topicId,
  highlighted = false,
  relationType,
  stanceStats,
}: Props) {
  const borderClass = relationType
    ? `border-l-4 ${getConnectorColorClass(relationType)}`
    : '';

  return (
    <div
      id={`msg-${message.id}`}
      className={`bg-white rounded-lg border p-4 ${borderClass} ${
        highlighted ? 'border-indigo-400 shadow-md' : 'border-gray-200'
      }`}
    >
      <p className="text-gray-800 whitespace-pre-wrap leading-relaxed">{message.content}</p>

      <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
        <div className="flex items-center gap-3">
          <span>
            <span className="font-medium text-gray-600">{message.createdBy.username}</span>
            {' · '}
            {new Date(message.createdAt).toLocaleString('zh-CN')}
          </span>
          {/* Stance stats: support/oppose counts */}
          {stanceStats && (stanceStats.support > 0 || stanceStats.oppose > 0) && (
            <span className="flex items-center gap-1.5">
              {stanceStats.support > 0 && (
                <span className="text-green-600 font-medium">▲ {stanceStats.support}</span>
              )}
              {stanceStats.oppose > 0 && (
                <span className="text-red-500 font-medium">▼ {stanceStats.oppose}</span>
              )}
            </span>
          )}
        </div>
        <Link
          to={`/topics/${topicId}/messages/${message.id}`}
          className="text-indigo-500 hover:text-indigo-700 font-medium transition-colors"
        >
          关联分析 →
        </Link>
      </div>
    </div>
  );
}

