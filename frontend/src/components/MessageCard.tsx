import { Link } from 'react-router-dom';
import type { Message, StanceStats } from '../types';

/** 关系类型对应的左边框颜色，用于在树中体现"立场"含义 */
const BORDER_COLOR: Record<string, string> = {
  SUPPORT: 'border-l-4 border-l-green-400',
  OPPOSE:  'border-l-4 border-l-red-400',
  CORRECT: 'border-l-4 border-l-yellow-400',
  REPLY:   'border-l-4 border-l-blue-400',
  QUOTE:   'border-l-4 border-l-indigo-300',
};

interface Props {
  message: Message;
  topicId: string;
  highlighted?: boolean;
  /** 该节点在树中的关系类型（父→子方向），用于显示左边框色 */
  relationType?: string;
  /** 支持/反对立场统计 */
  stanceStats?: StanceStats;
}

export default function MessageCard({
  message,
  topicId,
  highlighted = false,
  relationType,
  stanceStats,
}: Props) {
  const borderClass = relationType ? (BORDER_COLOR[relationType] ?? '') : '';

  return (
    <div
      id={`msg-${message.id}`}
      className={`bg-white rounded-lg border p-4 ${borderClass} ${
        highlighted ? 'border-indigo-400 shadow-md' : 'border-gray-200'
      }`}
    >
      {/* 引用块：若消息附带引用片段则展示 */}
      {message.quotedText && (
        <blockquote className="mb-3 border-l-4 border-indigo-300 pl-3 text-sm text-gray-500 italic bg-indigo-50 py-2 rounded-r">
          {message.quoteContextBefore && <span className="opacity-60">…{message.quoteContextBefore} </span>}
          <span className="font-medium text-indigo-700">{message.quotedText}</span>
          {message.quoteContextAfter && <span className="opacity-60"> {message.quoteContextAfter}…</span>}
        </blockquote>
      )}

      <p className="text-gray-800 whitespace-pre-wrap leading-relaxed">{message.content}</p>

      <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
        <div className="flex items-center gap-3">
          <span>
            <span className="font-medium text-gray-600">{message.createdBy.username}</span>
            {' · '}
            {new Date(message.createdAt).toLocaleString('zh-CN')}
          </span>
          {/* 立场统计：支持/反对数量 */}
          {stanceStats && (stanceStats.support > 0 || stanceStats.oppose > 0) && (
            <span className="flex items-center gap-1.5">
              {stanceStats.support > 0 && (
                <span className="text-green-600 font-medium">▲ {stanceStats.support} 支持</span>
              )}
              {stanceStats.oppose > 0 && (
                <span className="text-red-500 font-medium">▼ {stanceStats.oppose} 反对</span>
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
