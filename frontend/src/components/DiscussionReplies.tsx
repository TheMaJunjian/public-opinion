import { createContext, useContext } from 'react';
import type { DiscussionPageState } from '../data/discussionClient';

export const DiscussionRepliesContext = createContext<{
  state: DiscussionPageState;
  onMore(messageId: string): Promise<void>;
} | null>(null);

/** Keep the continuation attached to its original message in either canvas or list view. */
export default function DiscussionReplies({ messageId }: { messageId: string }) {
  const value = useContext(DiscussionRepliesContext);
  if (!value || (value.state.classificationId ?? value.state.focusId) !== messageId) return null;
  const { state, onMore } = value, noun = state.classificationId ? '消息' : '回复';
  if (!state.hasMore && !state.expanded && !state.error) return null;
  return <div data-discussion-replies={messageId} style={{ marginTop: 10, fontSize: 12 }}
    onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onMouseUp={event => event.stopPropagation()}>
    {state.hasMore ? <button type="button" disabled={state.loading} aria-busy={state.loadingMore}
      onClick={() => void onMore(messageId).catch(() => {})}>
      {state.loadingMore ? `正在加载${noun}…` : state.error ? `重试加载更多${noun}` : `加载更多${noun}`}
    </button> : state.expanded && <span style={{ color: 'var(--text-secondary)' }}>{noun}已全部加载</span>}
    {state.error && <div role="alert" style={{ marginTop: 6 }}>{state.error}</div>}
  </div>;
}
