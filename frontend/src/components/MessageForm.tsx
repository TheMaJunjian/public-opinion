import { useState } from 'react';

interface Props {
  onSubmit: (data: {
    content: string;
    quoteSourceId?: string;
    quotedText?: string;
    quoteContextBefore?: string;
    quoteContextAfter?: string;
  }) => Promise<void>;
}

export default function MessageForm({ onSubmit }: Props) {
  const [content, setContent] = useState('');
  const [showQuote, setShowQuote] = useState(false);
  const [quoteSourceId, setQuoteSourceId] = useState('');
  const [quotedText, setQuotedText] = useState('');
  const [quoteContextBefore, setQuoteContextBefore] = useState('');
  const [quoteContextAfter, setQuoteContextAfter] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) { setError('请输入观点内容'); return; }
    setError('');
    setSubmitting(true);
    try {
      await onSubmit({
        content: content.trim(),
        quoteSourceId: showQuote ? quoteSourceId : undefined,
        quotedText: showQuote ? quotedText : undefined,
        quoteContextBefore: showQuote ? quoteContextBefore : undefined,
        quoteContextAfter: showQuote ? quoteContextAfter : undefined,
      });
      setContent('');
      setQuoteSourceId('');
      setQuotedText('');
      setQuoteContextBefore('');
      setQuoteContextAfter('');
      setShowQuote(false);
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
      <div className="mt-2">
        <button
          type="button"
          onClick={() => setShowQuote(!showQuote)}
          className="text-xs text-indigo-600 hover:text-indigo-800 font-medium"
        >
          {showQuote ? '▲ 收起引用' : '▼ 添加引用（可选）'}
        </button>
      </div>
      {showQuote && (
        <div className="mt-3 space-y-2 border-t pt-3">
          <input
            value={quoteSourceId}
            onChange={e => setQuoteSourceId(e.target.value)}
            placeholder="引用来源消息 ID（可选）"
            className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <input
            value={quotedText}
            onChange={e => setQuotedText(e.target.value)}
            placeholder="引用文本片段"
            className="w-full border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
          />
          <div className="flex gap-2">
            <input
              value={quoteContextBefore}
              onChange={e => setQuoteContextBefore(e.target.value)}
              placeholder="前置上下文"
              className="flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
            <input
              value={quoteContextAfter}
              onChange={e => setQuoteContextAfter(e.target.value)}
              placeholder="后置上下文"
              className="flex-1 border border-gray-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </div>
        </div>
      )}
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
