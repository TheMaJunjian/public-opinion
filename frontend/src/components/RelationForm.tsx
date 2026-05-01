/**
 * RelationForm.tsx — Form for creating a new relation between messages/relations.
 *
 * Key architectural fix:
 *   Sources must be text messages only.
 *   Targets can be text messages OR relation messages (with a selectable part).
 *   This eliminates the bug where targeting a relation incorrectly resolved to
 *   the underlying text message.
 *
 * UI sections:
 *   1. Relation type selector (driven by PRESENTATION_SPECS)
 *   2. Source selector (text messages only)
 *   3. Target selector (text messages + relation messages)
 *   4. Optional fragment input for text-fragment targets
 */

import { useState } from 'react';
import type { Message, Relation, TargetRef } from '../types';
import { PRESENTATION_SPECS, getPresentationSpec } from '../types';

// Relation parts that can be selected on a relation message
const RELATION_PARTS = [
  { value: 'whole',      label: '整体' },
  { value: 'label',      label: '标签/连接线' },
  { value: 'decoration', label: '装饰徽标' },
  { value: 'frame',      label: '框架边界' },
] as const;

type RelationPart = typeof RELATION_PARTS[number]['value'];

interface Props {
  messages: Message[];
  relations: Relation[];
  onSubmit: (data: {
    relationType: string;
    sourceMessageId: string;
    targetRefs: TargetRef[];
  }) => Promise<void>;
}

export default function RelationForm({ messages, relations, onSubmit }: Props) {
  const [relationType, setRelationType] = useState('REPLY');
  const [sourceId, setSourceId] = useState('');

  // Target can be a message or a relation
  const [targetKind, setTargetKind] = useState<'message' | 'relation'>('message');
  const [targetMessageId, setTargetMessageId] = useState('');
  const [targetRelationId, setTargetRelationId] = useState('');
  const [targetRelationPart, setTargetRelationPart] = useState<RelationPart>('whole');

  // Optional text fragment for message targets
  const [useFragment, setUseFragment] = useState(false);
  const [fragmentText, setFragmentText] = useState('');

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const spec = getPresentationSpec(relationType);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!sourceId) {
      setError('请选择来源观点');
      return;
    }

    let targetRef: TargetRef | null = null;

    if (targetKind === 'message') {
      if (!targetMessageId) {
        setError('请选择目标观点');
        return;
      }
      if (sourceId === targetMessageId) {
        setError('来源观点和目标观点不能相同');
        return;
      }
      if (useFragment && fragmentText.trim()) {
        // Use crypto.subtle or a simple hash for the fragment
        const hash = btoa(fragmentText.trim()).slice(0, 16);
        targetRef = {
          kind: 'text-fragment',
          messageId: targetMessageId,
          text: fragmentText.trim(),
          hash,
        };
      } else {
        targetRef = { kind: 'message', messageId: targetMessageId };
      }
    } else {
      if (!targetRelationId) {
        setError('请选择目标关系消息');
        return;
      }
      targetRef = {
        kind: 'relation',
        relationId: targetRelationId,
        part: targetRelationPart === 'whole' ? undefined : targetRelationPart,
      };
    }

    setSubmitting(true);
    try {
      await onSubmit({
        relationType,
        sourceMessageId: sourceId,
        targetRefs: [targetRef],
      });
      // Reset form
      setSourceId('');
      setTargetMessageId('');
      setTargetRelationId('');
      setFragmentText('');
      setUseFragment(false);
      setTargetKind('message');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '创建关联失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <h3 className="text-base font-semibold text-gray-800">创建关系</h3>
      {error && <p className="text-red-500 text-sm">{error}</p>}

      {/* Relation Type */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">关系类型</label>
        <select
          value={relationType}
          onChange={e => setRelationType(e.target.value)}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
        >
          {Object.entries(PRESENTATION_SPECS).map(([key, s]) => (
            <option key={key} value={key}>
              {s.label}（{key}）
            </option>
          ))}
        </select>
        {spec && (
          <p className="text-xs text-gray-400 mt-1">
            显示形式：{
              spec.kind === 'edge-label'      ? '连接线+标签' :
              spec.kind === 'decoration'      ? '目标消息装饰徽标' :
              spec.kind === 'edge-decoration' ? '连接线+装饰徽标' :
              spec.kind === 'frame-group'     ? '分组框架' :
              spec.kind === 'replace-overlay' ? '替换/覆盖显示' :
              spec.kind === 'inline-badge'    ? '内联徽标' : spec.kind
            }
            {spec.stanceEffect && ` · 立场：${spec.stanceEffect === 'support' ? '✓ 支持' : '✗ 反对'}`}
          </p>
        )}
      </div>

      {/* Source — text messages only */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          来源观点 <span className="text-gray-400 font-normal text-xs">（仅限文本消息）</span>
        </label>
        <select
          value={sourceId}
          onChange={e => setSourceId(e.target.value)}
          className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
        >
          <option value="">请选择…</option>
          {messages.map(m => (
            <option key={m.id} value={m.id}>
              [{m.createdBy.username}] {m.content.slice(0, 40)}{m.content.length > 40 ? '…' : ''}
            </option>
          ))}
        </select>
      </div>

      {/* Target kind toggle */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">目标类型</label>
        <div className="flex rounded border border-gray-200 overflow-hidden text-sm">
          <button
            type="button"
            onClick={() => setTargetKind('message')}
            className={`flex-1 py-1.5 font-medium transition-colors ${
              targetKind === 'message' ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:bg-gray-50'
            }`}
          >
            文本消息
          </button>
          <button
            type="button"
            onClick={() => setTargetKind('relation')}
            className={`flex-1 py-1.5 font-medium transition-colors border-l border-gray-200 ${
              targetKind === 'relation' ? 'bg-indigo-600 text-white' : 'text-gray-500 hover:bg-gray-50'
            }`}
          >
            关系消息
          </button>
        </div>
      </div>

      {/* Target — message or relation */}
      {targetKind === 'message' ? (
        <div className="space-y-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">目标文本消息</label>
            <select
              value={targetMessageId}
              onChange={e => setTargetMessageId(e.target.value)}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            >
              <option value="">请选择…</option>
              {messages.map(m => (
                <option key={m.id} value={m.id}>
                  [{m.createdBy.username}] {m.content.slice(0, 40)}{m.content.length > 40 ? '…' : ''}
                </option>
              ))}
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
            <input
              type="checkbox"
              checked={useFragment}
              onChange={e => setUseFragment(e.target.checked)}
              className="rounded"
            />
            指向特定文字片段
          </label>
          {useFragment && (
            <input
              value={fragmentText}
              onChange={e => setFragmentText(e.target.value)}
              placeholder="粘贴目标消息中的片段文字"
              className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          )}
        </div>
      ) : (
        <div className="space-y-2">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              目标关系消息 <span className="text-gray-400 font-normal text-xs">（可递归建立关系）</span>
            </label>
            {relations.length === 0 ? (
              <p className="text-xs text-gray-400 py-2">当前话题暂无关系消息可选</p>
            ) : (
              <select
                value={targetRelationId}
                onChange={e => setTargetRelationId(e.target.value)}
                className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
              >
                <option value="">请选择…</option>
                {relations.map(r => {
                  const src = messages.find(m => m.id === r.sourceMessageId);
                  return (
                    <option key={r.id} value={r.id}>
                      [{src?.createdBy.username ?? '?'}的{getPresentationSpec(r.relationType).label}关系]
                    </option>
                  );
                })}
              </select>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">目标部件</label>
            <select
              value={targetRelationPart}
              onChange={e => setTargetRelationPart(e.target.value as RelationPart)}
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            >
              {RELATION_PARTS.map(p => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      <div className="pt-1 flex justify-end">
        <button
          type="submit"
          disabled={submitting}
          className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white px-5 py-2 rounded text-sm font-medium transition-colors"
        >
          {submitting ? '创建中…' : '创建关系'}
        </button>
      </div>
    </form>
  );
}

