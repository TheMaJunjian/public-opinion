import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { FeedItem, FeedMode, FeedPreview } from '@gonglun/core';
import { api } from '../api';
import { startEntryTiming } from '../utils/entryTiming';
import '../theme/feed.css';

const tabs: Array<{ mode: FeedMode; label: string }> = [
  { mode: 'recommended', label: '推荐' }, { mode: 'following', label: '关注' }, { mode: 'latest', label: '最新' },
];
const linkTo = (id: string) => `/messages?msg=${encodeURIComponent(id)}&locate=1`;
const date = (value: string) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? '' : parsed.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
};

function Preview({ item, update = false }: { item: FeedPreview; update?: boolean }) {
  // Final server-side moderation can redact content between candidate selection and delivery.
  if (!item.excerpt) return null;
  return <div className={update ? 'feed-update' : 'feed-preview'}>
    <div className="feed-meta"><span>{item.kind}</span><span>{item.author?.username}</span><time dateTime={item.createdAt}>{date(item.createdAt)}</time></div>
    <Link className="feed-content" to={linkTo(item.id)}>{item.excerpt}</Link>
    {item.hasCorrections && <p className="feed-correction">原文摘要 · 此消息有更正记录，进入讨论查看版本</p>}
  </div>;
}

/** Discovery has no dependency on the workbench, its catalog worker or graph model. */
export default function FeedPage() {
  const [params, setParams] = useSearchParams();
  const selected = params.get('feed');
  const mode: FeedMode = selected === 'following' || selected === 'latest' ? selected : 'recommended';
  const [items, setItems] = useState<FeedItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expired, setExpired] = useState(false);
  const [fallback, setFallback] = useState(false);
  const [revision, setRevision] = useState(0);
  const [hidden, setHidden] = useState<FeedItem | null>(null);
  const [feedbackError, setFeedbackError] = useState('');
  const [saving, setSaving] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const readyTiming = useRef<(() => void) | null>(null);
  const busy = useRef(false);
  const actualMode = useRef(mode);

  async function load(next?: string) {
    if (busy.current) return;
    busy.current = true;
    const controller = new AbortController(); request.current = controller;
    const current = generation.current;
    setLoading(true); setError(''); setExpired(false);
    const finishRequest = startEntryTiming('feed-request');
    try {
      let page;
      try { page = await api.getFeed(actualMode.current, next, controller.signal); }
      catch (failure) {
        const status = (failure as { status?: number }).status;
        if (controller.signal.aborted || next || mode !== 'recommended' || status && status < 500) throw failure;
        page = await api.getFeed('latest', undefined, controller.signal);
        if (!controller.signal.aborted && current === generation.current) { actualMode.current = 'latest'; setFallback(true); }
      }
      if (controller.signal.aborted || current !== generation.current) return;
      setItems(previous => next ? [...new Map([...previous, ...page.items].map(item => [item.id, item])).values()] : page.items);
      setCursor(page.nextCursor);
    } catch (failure) {
      if (controller.signal.aborted || current !== generation.current) return;
      setExpired((failure as { code?: string }).code === 'FEED_EXPIRED');
      setError(failure instanceof Error ? failure.message : '内容加载失败，请重试');
    } finally {
      finishRequest();
      if (!controller.signal.aborted && current === generation.current) { busy.current = false; setLoading(false); }
    }
  }

  useEffect(() => {
    generation.current++; request.current?.abort(); busy.current = false;
    actualMode.current = mode; setFallback(false);
    setItems([]); setCursor(null); setHidden(null); setFeedbackError(''); setSaving(null);
    readyTiming.current = startEntryTiming('feed-ready');
    void load();
    return () => { generation.current++; request.current?.abort(); busy.current = false; };
  }, [mode, revision]);
  useEffect(() => {
    if (loading || error) return;
    const frame = requestAnimationFrame(() => {
      if (!readyTiming.current) return;
      readyTiming.current(); readyTiming.current = null;
      window.dispatchEvent(new Event('gonglun:entry-ready'));
    });
    return () => cancelAnimationFrame(frame);
  }, [loading, error]);

  const refresh = () => setRevision(value => value + 1);
  async function hide(item: FeedItem, undo = false) {
    const current = generation.current;
    setSaving(item.id); setFeedbackError('');
    try {
      await api.setFeedHidden(item.id, !undo);
      if (current !== generation.current) return;
      if (undo) { setHidden(null); refresh(); }
      else { setItems(previous => previous.filter(value => value.id !== item.id)); setHidden(item); }
    } catch (failure) {
      if (current === generation.current) setFeedbackError(failure instanceof Error ? failure.message : '偏好保存失败，请重试');
    } finally { if (current === generation.current) setSaving(null); }
  }

  return <section className="feed-page" aria-label="讨论首页">
    <header className="feed-header">
      <div><p className="feed-eyebrow">公论 · 发现与参与</p><h1>值得继续的讨论</h1><p className="feed-description">关注新的进展，也发现不同的观点。</p></div>
      <Link className="feed-workbench" to="/messages">进入消息工作台 <span aria-hidden="true">↗</span></Link>
    </header>
    <div className="feed-navigation">
      <nav className="feed-tabs" aria-label="内容范围">{tabs.map(tab => <Link key={tab.mode}
        to={tab.mode === 'recommended' ? '/' : `/?feed=${tab.mode}`} aria-current={mode === tab.mode ? 'page' : undefined}>{tab.label}</Link>)}</nav>
      <button type="button" onClick={refresh} disabled={loading}>刷新</button>
    </div>
    {mode === 'recommended' && <details className="feed-explanation"><summary>推荐如何选择内容</summary>
      <p>优先展示你关注的消息、分类及与你参与有关的近期讨论，再参考更新时间和已阅记录。相同直接讨论上下文会合并，并保留发现新内容的位置。</p>
      <p>推荐不代表赞同或真假判断。你可以隐藏某条讨论，或切换“最新”按时间浏览。浏览摘要不会自动确认已阅。</p>
    </details>}
    {hidden && <div className="feed-notice" role="status">已减少此讨论的展示。<button type="button" disabled={saving !== null} onClick={() => void hide(hidden, true)}>撤销</button></div>}
    {fallback && <p className="feed-notice" role="status">推荐暂未准备好，先为你展示最新讨论。</p>}
    {feedbackError && <p className="feed-error" role="alert">{feedbackError}</p>}
    {error && <div className="feed-error" role="alert"><p>{error}</p><button type="button" onClick={() => expired ? refresh() : void load(cursor ?? undefined)} disabled={loading}>{expired ? '刷新列表' : '重试'}</button>
      {mode === 'recommended' && <button type="button" onClick={() => setParams({ feed: 'latest' })}>查看最新内容</button>}</div>}
    <div className="feed-list" aria-busy={loading}>{items.filter(item => item.excerpt).map(item => <article key={item.id} className="feed-card" aria-label={`${item.author?.username ?? '与会者'}的${item.kind ?? '讨论'}`}>
      <div className="feed-reason">{item.reasons?.join(' · ')}</div>
      <Preview item={item} />
      {!!item.updates?.length && <div className="feed-updates"><p>相关进展</p>{item.updates.map(update => <Preview key={update.id} item={update} update />)}</div>}
      <footer><Link to={linkTo(item.id)}>进入讨论 <span aria-hidden="true">→</span></Link>
        <button type="button" disabled={saving !== null} onClick={() => void hide(item)}>减少此讨论</button></footer>
    </article>)}</div>
    {loading && <div role="status" className="feed-loading">{items.length ? '正在加载更多讨论…' : '正在为你准备讨论…'}
      {!items.length && <div className="feed-skeleton" aria-hidden="true"><span /><span /><span /></div>}</div>}
    {!loading && !error && !items.length && <div className="feed-empty"><h2>{mode === 'following' ? '这里会汇集你关注的讨论' : '暂时没有可展示的讨论'}</h2>
      <p>{mode === 'following' ? '进入讨论后关注消息或分类，下次回来就能从这里继续。' : '可以查看最新内容，或进入工作台发起讨论。'}</p>
      {mode !== 'latest' && <Link to="/?feed=latest">发现最新讨论</Link>}<Link to="/messages">进入消息工作台</Link></div>}
    {!loading && !error && cursor && <button type="button" className="feed-more" onClick={() => void load(cursor)}>加载更多</button>}
    {!loading && !error && items.length > 0 && !cursor && <p className="feed-end">{mode === 'latest' ? '已看到这次浏览的最新内容' : '已看完这批讨论'} · <button type="button" onClick={refresh}>刷新看看</button></p>}
  </section>;
}
