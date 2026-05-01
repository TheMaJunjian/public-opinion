/**
 * RelationView.tsx — Shows all relations involving a given message.
 *
 * Bug fix: When a relation targets another relation message, the target display
 * now correctly shows the RELATION MESSAGE itself (with its selectable part),
 * not the underlying text messages that the relation connects.
 *
 * Old (broken): targetRef.targetMessageId always resolved to a text message ID.
 * New (fixed):  targetRef uses a discriminated union; 'relation' kind renders
 *               the relation's own identity, not its endpoints.
 */

import { Link } from 'react-router-dom';
import type { Message, Relation, TargetRef } from '../types';
import { getPresentationSpec } from '../types';
import RelationBadge from './RelationBadge';

interface Props {
  messageId: string;
  topicId: string;
  relations: Relation[];
  messages: Message[];
}

/** Render a single TargetRef as a readable description */
function TargetRefDisplay({
  ref,
  messages,
  relations,
  topicId,
}: {
  ref: TargetRef;
  messages: Message[];
  relations: Relation[];
  topicId: string;
}) {
  if (ref.kind === 'message') {
    const msg = messages.find(m => m.id === ref.messageId);
    return msg ? (
      <Link to={`/topics/${topicId}/messages/${msg.id}`} className="text-indigo-600 hover:underline">
        [{msg.createdBy.username}] {msg.content.slice(0, 30)}…
      </Link>
    ) : (
      <span className="text-gray-400">消息 {ref.messageId.slice(0, 8)}…</span>
    );
  }

  if (ref.kind === 'text-fragment') {
    const msg = messages.find(m => m.id === ref.messageId);
    return (
      <span className="text-indigo-600">
        {msg ? `[${msg.createdBy.username}] ` : ''}
        <em className="bg-yellow-100 px-1 rounded">"{ref.text.slice(0, 25)}…"</em>
      </span>
    );
  }

  if (ref.kind === 'relation') {
    // KEY FIX: render the relation message itself, not its underlying text messages
    const rel = relations.find(r => r.id === ref.relationId);
    const part = ref.part ?? 'whole';
    const partLabel: Record<string, string> = {
      label: '标签',
      decoration: '装饰',
      frame: '框架',
      whole: '整体',
    };
    const spec = rel ? getPresentationSpec(rel.relationType) : null;
    return rel ? (
      <span className="inline-flex items-center gap-1">
        <span className="text-gray-400 text-xs">关系消息</span>
        <RelationBadge type={rel.relationType} />
        <span className="text-gray-400 text-xs">的{partLabel[part]}</span>
        {spec && <span className="text-xs text-gray-400">（{spec.kind}）</span>}
      </span>
    ) : (
      <span className="text-gray-400">关系 {ref.relationId.slice(0, 8)}…</span>
    );
  }

  return null;
}

/** Groups and displays all relations involving a given message */
export default function RelationView({ messageId, topicId, relations, messages }: Props) {
  // Relations where this message is the source
  const asSource = relations.filter(r => r.sourceMessageId === messageId);

  // Relations where this message is a TEXT target
  const asTarget = relations.filter(r =>
    r.targetRefs.some(ref =>
      (ref.kind === 'message' || ref.kind === 'text-fragment') && ref.messageId === messageId,
    ),
  );

  if (asSource.length === 0 && asTarget.length === 0) {
    return <p className="text-sm text-gray-400">暂无关联</p>;
  }

  return (
    <div className="space-y-4">
      {asSource.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-gray-600 mb-2">该观点发起的关系：</h4>
          <div className="space-y-2">
            {asSource.map(rel => (
              <div key={rel.id} className="flex flex-wrap items-center gap-2 text-sm">
                <RelationBadge type={rel.relationType} />
                <span className="text-gray-500">→</span>
                {rel.targetRefs.map((ref, i) => (
                  <TargetRefDisplay
                    key={i}
                    ref={ref}
                    messages={messages}
                    relations={relations}
                    topicId={topicId}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {asTarget.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold text-gray-600 mb-2">其他观点对此的态度：</h4>
          <div className="space-y-2">
            {asTarget.map(rel => {
              const source = messages.find(m => m.id === rel.sourceMessageId);
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
