import { useState } from 'react';
import type { Message, TargetRef } from '../types';

const RELATION_TYPES = [
  { value: 'REPLY', label: '回复' },
  { value: 'SUPPORT', label: '支持' },
  { value: 'OPPOSE', label: '反对' },
  { value: 'CORRECT', label: '纠正' },
  { value: 'QUOTE', label: '引用' },
  { value: 'LINK', label: '关联' },
  { value: 'UNLINK', label: '取消关联' },
];

interface Props {
  messages: Message[];
  onSubmit: (data: {
    relationType: string;
    sourceMessageId: string;
    targetRefs: TargetRef[];
  }) => Promise<void>;
}

export default function RelationForm({ messages, onSubmit }: Props) {
  const [relationType, setRelationType] = useState('REPLY');
  const [sourceId, setSourceId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [targetSelectedText, setTargetSelectedText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!sourceId || !targetId) { setError('请选择来源观点和目标观点'); return; }
    if (sourceId === targetId) { setError('来源观点和目标观点不能相同'); return; }
    setError('');
    setSubmitting(true);
    try {
      await onSubmit({
        relationType,
        sourceMessageId: sourceId,
        targetRefs: [{ targetMessageId: targetId, targetSelectedText: targetSelectedText || undefined }],
      });
      setSourceId('');
      setTargetId('');
      setTargetSelectedText('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '创建关联失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-lg p-4">
      <h3 className="text-base font-semibold text-gray-800 mb-3">创建观点关联</h3>
      {error && <p className="text-red-500 text-sm mb-2">{error}</p>}
      <div className="space-y-3">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">关联类型</label>
          <select
            value={relationType}
            onChange={e => setRelationType(e.target.value)}
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          >
            {RELATION_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">来源观点</label>
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
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">目标观点</label>
          <select
            value={targetId}
            onChange={e => setTargetId(e.target.value)}
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
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">目标选中文本（可选）</label>
          <input
            value={targetSelectedText}
            onChange={e => setTargetSelectedText(e.target.value)}
            placeholder="关联的特定文本片段"
            className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <button
          type="submit"
          disabled={submitting}
          className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white px-5 py-2 rounded text-sm font-medium transition-colors"
        >
          {submitting ? '创建中…' : '创建关联'}
        </button>
      </div>
    </form>
  );
}
