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
  /** Called when the card is single-clicked (for adding to draft) */
  onClick?: () => void;
  /** Whether this message is currently selected in the draft/sources/targets */
  isSelected?: boolean;
}

export default function MessageCard({
  message,
  topicId,
  highlighted = false,
  relationType,
  stanceStats,
  onClick,
  isSelected = false,
}: Props) {
  const borderClass = relationType
    ? `border-l-4 ${getConnectorColorClass(relationType)}`
    : '';

  return (
    <div
      id={`msg-${message.id}`}
      onClick={onClick}
      className={`bg-white rounded-lg border p-4 ${borderClass} ${
        isSelected
          ? 'border-indigo-400 shadow-md ring-2 ring-indigo-200'
          : highlighted
          ? 'border-indigo-300 shadow-sm'
          : 'border-gray-200'
      } ${onClick ? 'cursor-pointer hover:border-indigo-300 hover:shadow-sm transition-all' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-gray-800 whitespace-pre-wrap leading-relaxed flex-1">{message.content}</p>
        {isSelected && (
          <span className="shrink-0 text-indigo-600 text-xs font-bold px-1 py-0.5 bg-indigo-50 rounded border border-indigo-200">
            已选中
          </span>
        )}
      </div>

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
          onClick={e => e.stopPropagation()}
          className="text-indigo-500 hover:text-indigo-700 font-medium transition-colors"
        >
          关联分析 →
        </Link>
      </div>
    </div>
  );
}

