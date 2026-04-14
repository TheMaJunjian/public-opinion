import type { Relation, Message } from '../types';
import RelationBadge from './RelationBadge';
import { Link } from 'react-router-dom';

interface Props {
  messageId: string;
  topicId: string;
  relations: Relation[];
  messages: Message[];
}

/** Groups and displays all relations involving a given message */
export default function RelationView({ messageId, topicId, relations, messages }: Props) {
  const getMsg = (id: string) => messages.find(m => m.id === id);

  // Relations where this message is the source
  const asSource = relations.filter(r => r.sourceMessageId === messageId);
  // Relations where this message is a target
  const asTarget = relations.filter(r => r.targetRefs.some(ref => ref.targetMessageId === messageId));

  if (asSource.length === 0 && asTarget.length === 0) {
    return <p className="text-sm text-gray-400">暂无关联</p>;
  }

  return (
    <div className="space-y-4">
      {asSource.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-gray-600 mb-2">该观点的主张：</h4>
          <div className="space-y-2">
            {asSource.map(rel => {
              const targets = rel.targetRefs.map(ref => getMsg(ref.targetMessageId)).filter(Boolean);
              return (
                <div key={rel.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <RelationBadge type={rel.relationType} />
                  <span className="text-gray-500">→</span>
                  {targets.map(target => target && (
                    <Link
                      key={target.id}
                      to={`/topics/${topicId}/messages/${target.id}`}
                      className="text-indigo-600 hover:underline"
                    >
                      [{target.createdBy.username}] {target.content.slice(0, 30)}…
                    </Link>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {asTarget.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-gray-600 mb-2">其他观点对此的态度：</h4>
          <div className="space-y-2">
            {asTarget.map(rel => {
              const source = getMsg(rel.sourceMessageId);
              return (
                <div key={rel.id} className="flex flex-wrap items-center gap-2 text-sm">
                  {source && (
                    <Link
                      to={`/topics/${topicId}/messages/${source.id}`}
                      className="text-indigo-600 hover:underline"
                    >
                      [{source.createdBy.username}] {source.content.slice(0, 30)}…
                    </Link>
                  )}
                  <span className="text-gray-500">→</span>
                  <RelationBadge type={rel.relationType} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
