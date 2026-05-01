import { useState } from 'react';

interface Props {
  onSubmit: (data: { content: string; contentType?: 'TEXT' | 'MARKDOWN' }) => Promise<void>;
}

export default function MessageForm({ onSubmit }: Props) {
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) { setError('请输入观点内容'); return; }
    setError('');
    setSubmitting(true);
    try {
      await onSubmit({ content: content.trim() });
      setContent('');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '发表失败，请重试');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-gray-200 rounded-lg p-4">
      <h3 className="text-base font-semibold text-gray-800 mb-3">发表观点</h3>
      {error && <p className="text-red-500 text-sm mb-2">{error}</p>}
      <textarea
        value={content}
        onChange={e => setContent(e.target.value)}
        placeholder="请输入您的观点…"
        rows={4}
        className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400 resize-none"
      />
      <p className="text-xs text-gray-400 mt-1">
        提示：发表后可通过"添加关系"与其他观点建立关联（引用、支持、反驳等）
      </p>
      <div className="mt-3 flex justify-end">
        <button
          type="submit"
          disabled={submitting}
          className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white px-5 py-2 rounded text-sm font-medium transition-colors"
        >
          {submitting ? '发表中…' : '发表观点'}
        </button>
      </div>
    </form>
  );
}

