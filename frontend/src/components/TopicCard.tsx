import { Link } from 'react-router-dom';
import type { Topic } from '../types';

interface Props {
  topic: Topic;
}

export default function TopicCard({ topic }: Props) {
  const isOpen = topic.status === 'OPEN';
  return (
    <Link
      to={`/topics/${topic.id}`}
      className="block bg-white rounded-lg border border-gray-200 hover:border-indigo-400 hover:shadow-md transition-all p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-lg font-semibold text-gray-900 leading-snug">{topic.title}</h2>
        <span
          className={`shrink-0 text-xs font-medium px-2 py-0.5 rounded-full ${
            isOpen ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
          }`}
        >
          {isOpen ? '进行中' : '已归档'}
        </span>
      </div>
      {topic.body && (
        <p className="mt-2 text-sm text-gray-500 line-clamp-2">{topic.body}</p>
      )}
      <div className="mt-3 flex items-center gap-4 text-xs text-gray-400">
        <span>由 <span className="font-medium text-gray-600">{topic.createdBy.username}</span> 发起</span>
        {topic._count && (
          <>
            <span>💬 {topic._count.messages} 条观点</span>
            {topic._count.relations != null && <span>🔗 {topic._count.relations} 条关联</span>}
          </>
        )}
        <span>{new Date(topic.createdAt).toLocaleDateString('zh-CN')}</span>
      </div>
    </Link>
  );
}
