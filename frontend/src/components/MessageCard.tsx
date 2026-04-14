import { Link } from 'react-router-dom';
import type { Message } from '../types';

interface Props {
  message: Message;
  topicId: string;
  highlighted?: boolean;
}

export default function MessageCard({ message, topicId, highlighted = false }: Props) {
  return (
    <div
      id={`msg-${message.id}`}
      className={`bg-white rounded-lg border p-4 ${
        highlighted ? 'border-indigo-400 shadow-md' : 'border-gray-200'
      }`}
    >
      {message.quotedText && (
        <blockquote className="mb-3 border-l-4 border-indigo-300 pl-3 text-sm text-gray-500 italic bg-indigo-50 py-2 rounded-r">
          {message.quoteContextBefore && <span className="opacity-60">…{message.quoteContextBefore} </span>}
          <span className="font-medium text-indigo-700">{message.quotedText}</span>
          {message.quoteContextAfter && <span className="opacity-60"> {message.quoteContextAfter}…</span>}
        </blockquote>
      )}
      <p className="text-gray-800 whitespace-pre-wrap leading-relaxed">{message.content}</p>
      <div className="mt-3 flex items-center justify-between text-xs text-gray-400">
        <span>
          <span className="font-medium text-gray-600">{message.createdBy.username}</span>
          {' · '}
          {new Date(message.createdAt).toLocaleString('zh-CN')}
        </span>
        <Link
          to={`/topics/${topicId}/messages/${message.id}`}
          className="text-indigo-500 hover:text-indigo-700 font-medium transition-colors"
        >
          查看关联 →
        </Link>
      </div>
    </div>
  );
}
