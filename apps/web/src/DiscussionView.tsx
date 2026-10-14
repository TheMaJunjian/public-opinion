import { memo, type ReactNode } from 'react';
import { relations, textOf, type Message, type Reference } from '@gonglun/core';
import type { DiscussionModel } from './discussion';

interface Props {
  model: DiscussionModel;
  renderMessage: (message: Message, members: ReactNode) => ReactNode;
  onFocus: (reference: Reference) => void;
}
export function referenceLabel(reference: Reference): string {
  return [reference.partId ? `部件 ${reference.partId}` : '整条消息', reference.memberId ? `成员 ${reference.memberId}` : '', reference.path?.length ? reference.path.join('.') : '', reference.range ? `第 ${reference.range.start + 1}–${reference.range.end} 字` : '', reference.revision ? `v${reference.revision}` : '当前版本'].filter(Boolean).join(' · ');
}

function DiscussionView({ model, renderMessage, onFocus }: Props) {
  const render = (message: Message, depth = 0): ReactNode => {
    const sides = model.sides.get(message.id);
    const basis = model.placements.get(message.id);
    const target = basis && model.messages.get(basis.target.messageId);
    const original = basis && relations(message).find(part => part.id === basis.partId)?.roles.target?.[0]?.reference;
    const indirect = !!basis && !!original && (original.messageId !== basis.target.messageId || original.partId !== basis.target.partId);
    const historicalTarget = !!basis?.target.revision && !!target && basis.target.revision !== target.revision;
    const nested = depth > 0;
    const title = textOf(message).slice(0, 45) || `消息 ${message.id.slice(-7)}`;
    const hasSides = !!(sides?.pro.length || sides?.con.length);
    if (depth >= 4) return <section key={message.id} className="discussion-continuation" data-discussion-trace={message.id}><span>关联讨论继续展开</span><button type="button" onClick={() => onFocus({ messageId: message.id })}>查看「{title}」及关联 ↗</button></section>;
    return <section key={message.id} id={`discussion-${message.id}`} className={`local-discussion ${nested ? 'nested-discussion' : ''} ${hasSides ? 'with-positions' : 'single-position'}`} data-discussion-message={message.id} aria-label={`围绕：${title}`}>
      <div className="discussion-center">
        {model.contextual.has(message.id) && <div className="context-target-label">关联目标</div>}
        {basis && <button type="button" className={`stance-destination ${basis.side}`} onClick={() => onFocus(basis.target)}>
          <strong>{indirect ? '对原目标：' : ''}{basis.side === 'pro' ? '赞同' : '反对'}</strong> {target ? `「${historicalTarget ? `消息 ${target.id.slice(-7)}` : textOf(target).slice(0, 26) || target.id.slice(-7)}」` : `尚未加载的消息 ${basis.target.messageId.slice(-7)}`} ↗
          <span>{indirect ? '通过关联表态 · ' : ''}{referenceLabel(basis.target)}</span>
          {historicalTarget && <span>针对历史第 {basis.target.revision} 版 · 点击查看原文</span>}
          {message.revision !== basis.sourceRevision && <span>按第 {basis.sourceRevision} 版表态</span>}
        </button>}
        {renderMessage(message, <>{(model.members.get(message.id) || []).map(child => render(child, depth + 1))}</>)}
      </div>
      {hasSides && (['pro', 'con'] as const).map(side => <div className={`local-side ${side}`} key={side} data-stance-side={side}>
        <div className="local-side-heading"><span>{side === 'pro' ? '＋ 相关赞同' : '－ 相关反对'}</span><small>{sides![side].length}</small></div>
        {sides![side].length ? sides![side].map(child => render(child, depth + 1)) : <p className="local-side-empty">暂无已加载的{side === 'pro' ? '赞同' : '反对'}</p>}
      </div>)}
    </section>;
  };
  return <div className="local-discussion-feed">{model.roots.map(message => render(message))}</div>;
}
export default memo(DiscussionView);
