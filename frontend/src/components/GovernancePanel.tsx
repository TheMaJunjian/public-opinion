import { useState, useEffect } from 'react';
import { api } from '../api';
import type { Message } from '../types';

export default function GovernancePanel({ scopeMessageId }: { scopeMessageId: string }) {
  const [proposals, setProposals] = useState<Message[]>([]);
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Load governance proposals from regular message list (now includes kind: GOVERNANCE)
  useEffect(() => {
    if (!scopeMessageId) return;
    setLoading(true);
    api.getMessages(scopeMessageId, { limit: 50 })
      .then(r => {
        const msgs = r.data as unknown as Array<{ kind?: string; content?: string; id: string; createdAt: string; createdBy: { username: string } }>;
        setProposals(msgs.filter(m => m.kind === 'GOVERNANCE') as unknown as Message[]);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [scopeMessageId]);

  async function handleSubmit() {
    if (!content.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.createMessage(scopeMessageId, {
        kind: 'GOVERNANCE',
        contentType: 'TEXT',
        content: content.trim(),
        wager: 1,
        selfAgree: true,
      });
      setContent('');
      // Refresh
      const r = await api.getMessages(scopeMessageId, { limit: 50 });
      const govMsgs = r.data.filter(m => m.kind === 'GOVERNANCE');
      setProposals(govMsgs);
    } catch (e: unknown) {
      setError((e as Error)?.message ?? '提交失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="border border-[color:var(--line-e5e7eb)] rounded-lg p-4 bg-[color:var(--surface-fff)] space-y-4">
      <h3 className="font-semibold text-[color:var(--ink-1f2937)] text-sm">🏛️ 治理提案</h3>

      {/* New proposal form */}
      <div className="space-y-2">
        <textarea
          value={content}
          onChange={e => setContent(e.target.value)}
          placeholder="输入治理提案内容..."
          className="w-full border border-[color:var(--line-d1d5db)] rounded p-2 text-sm min-h-[60px] resize-y"
          rows={3}
        />
        {error && <div className="text-[color:var(--ink-ef4444)] text-xs">{error}</div>}
        <button
          onClick={handleSubmit}
          disabled={submitting || !content.trim()}
          className="px-3 py-1.5 bg-[color:var(--surface-4f46e5)] hover:bg-[color:var(--surface-4338ca)] text-[color:var(--ink-fff-2)] text-xs font-medium rounded transition-colors disabled:opacity-50"
        >
          {submitting ? '提交中...' : '发起提案'}
        </button>
      </div>

      {/* Existing proposals */}
      {loading ? (
        <div className="text-sm text-[color:var(--ink-6b7280)]">加载中...</div>
      ) : proposals.length === 0 ? (
        <div>
          <div className="text-sm text-[color:var(--ink-9ca3af)]">暂无治理提案</div>
          <div className="text-xs text-[color:var(--ink-6b7280)] mt-1">治理提案用于修改系统规则或参数。任何人都可以发起提案，经过社区讨论、投票（赞同/反对）、结算后决定是否采纳。通过后的提案由运营者执行并公告。</div>
        </div>
      ) : (
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {proposals.map(p => (
            <div key={p.id} className="border border-[color:var(--line-f3f4f6)] rounded p-2 text-xs">
              <div className="text-[color:var(--ink-1f2937)] whitespace-pre-wrap line-clamp-3">{p.content}</div>
              <div className="flex justify-between mt-1 text-[color:var(--ink-9ca3af)]">
                <span>{p.createdBy?.username}</span>
                <span>{new Date(p.createdAt).toLocaleDateString('zh-CN')}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
