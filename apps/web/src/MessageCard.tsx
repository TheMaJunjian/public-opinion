import { memo, useMemo } from 'react';
import { RELATION_LABELS, organization, relations, type Message, type Reference, type User } from '@gonglun/core';

export function timeLabel(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}
export function safeUrl(value: string): string | undefined {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
interface Props {
  message: Message; user?: User; selected: boolean; checked: boolean; suppressed: boolean;
  mark?: string;
  recommendationTotal?: number; supportCount?: number; oppositionCount?: number;
  onSelect: (id: string) => void; onCheck: (id: string) => void;
  onFollow: (reference: Reference) => void;
  onAction: (relation: string, targets: Reference[]) => void; onNavigate: (id: string) => void;
}
function MessageCard({ message, user, selected, checked, suppressed, mark, recommendationTotal, supportCount = 0, oppositionCount = 0, onSelect, onFollow, onCheck, onAction, onNavigate }: Props) {
  const group = organization(message);
  const links = useMemo(() => relations(message).filter(part => part.relation !== 'member-of'), [message]);
  const stance = links.find(part => part.relation === 'agree' || part.relation === 'disagree')?.relation;
  const prominence = Math.min(3, Math.floor(Math.log10((recommendationTotal ?? message.spending.recommendation) + 1)));
  return <article className={`message-card ${selected ? 'selected' : ''} ${checked ? 'checked' : ''} ${suppressed ? 'trace-card' : ''} prominence-${prominence}`} data-message-id={message.id} tabIndex={0} onKeyDown={event => { if (event.target === event.currentTarget && event.key === 'Enter') onSelect(message.id); }} onClick={() => onSelect(message.id)}>
    <div className="card-meta"><span className="avatar">{(user?.name || '公').slice(0, 1)}</span><span className="author">{user?.name || `用户 ${message.authorId.slice(-5)}`}</span>{user?.founder && <span className="founder-dot" title="发起人">◆</span>}<time dateTime={message.createdAt}>{timeLabel(message.createdAt)}</time><input type="checkbox" aria-label={`选择消息 ${message.id.slice(-7)}`} checked={checked} onClick={event => event.stopPropagation()} onChange={() => onCheck(message.id)}/></div>
    {links.length > 0 && <div className="relation-badges">{links.map(part => <button key={part.id} type="button" className={`relation-badge ${part.relation}`} title="查看关系部件" onClick={event => { event.stopPropagation(); onSelect(message.id); }}>{RELATION_LABELS[part.relation] || part.relation}</button>)}{message.revision > 1 && <span className="revision">v{message.revision}</span>}</div>}
    {suppressed && <p className="trace-label">覆盖已取消 · 组织记录仍可讨论</p>}
    {mark && <p className="message-mark">{mark}</p>}
    {message.authorId === 'system' && message.revision > 1 && <div className="notice">内容已修订，执行记录见第 1 版。编辑不会再次执行转账。<button type="button" onClick={event => { event.stopPropagation(); onFollow({ messageId: message.id, revision: 1 }); }}>查看原始执行记录</button></div>}
    <div className="message-content">{message.parts.map(part => {
      if (part.type === 'text') return <p key={part.id}>{part.text}</p>;
      if (part.type === 'web') return <blockquote key={part.id}><p>{part.excerpt}</p><a href={safeUrl(part.url)} target="_blank" rel="noopener noreferrer" onClick={event => event.stopPropagation()}>↗ {(() => { try { return new URL(part.url).hostname; } catch { return part.url; } })()}</a></blockquote>;
      if (part.type === 'code') return <div key={part.id} className="code-block"><span>{part.language}</span><pre><code>{part.source}</code></pre></div>;
      if (part.type === 'data') {
        const value = part.value && typeof part.value === 'object' && !Array.isArray(part.value) ? part.value : null;
        if (value && typeof value.label === 'string') return <span className="annotation" key={part.id}>{value.label}</span>;
        if (value && typeof value.total === 'number' && message.authorId === 'system' && message.revision === 1) return <div key={part.id} className="allocation-summary"><strong>{value.total}</strong> 贡献点分配 · 已执行</div>;
      }
      return null;
    })}</div>
    {links.some(part => Object.keys(part.roles).some(role => role !== 'members')) && <div className="card-targets">{links.flatMap(part => Object.entries(part.roles).filter(([role]) => role !== 'members').flatMap(([role, bindings]) => bindings.slice(0, 3).map(({ id, reference: ref }) => <button type="button" key={`${part.id}-${role}-${id}`} onClick={event => { event.stopPropagation(); onFollow(ref); }}>↗ {ref.messageId.slice(-7)}{ref.partId ? ` · ${ref.partId}` : ''}</button>)))}</div>}
    {group && <button type="button" className="open-organization" onClick={event => { event.stopPropagation(); onNavigate(message.id); }}>{suppressed ? '查看原组织与成员' : group.relation === 'summary' ? '展开讨论过程' : '进入讨论'} <span>↗</span></button>}
    <div className="card-footer"><div className="card-votes"><button type="button" className={stance === 'agree' ? 'active-pro' : ''} onClick={event => { event.stopPropagation(); onAction('agree', [{ messageId: message.id }]); }}>＋ 赞同{supportCount > 0 ? ` ${supportCount}` : ''}</button><button type="button" className={stance === 'disagree' ? 'active-con' : ''} onClick={event => { event.stopPropagation(); onAction('disagree', [{ messageId: message.id }]); }}>－ 反对{oppositionCount > 0 ? ` ${oppositionCount}` : ''}</button><button type="button" onClick={event => { event.stopPropagation(); onAction('reply', [{ messageId: message.id }]); }}>回复</button></div><span className="investment">{message.spending.recommendation > 0 ? `推荐 ${message.spending.recommendation}` : ''}{message.spending.wager > 0 ? ` · 对赌 ${message.spending.wager}` : ''}</span></div>
  </article>;
}
export default memo(MessageCard);
