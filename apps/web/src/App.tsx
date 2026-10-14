import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { DEFAULT_RULES, RELATION_LABELS, organization, projectMessages, relations, textOf, type Change, type Context, type Json, type LedgerEntry, type Message, type Reference, type Rules, type SendInput, type Session } from '@gonglun/core';
import { api, inQueryScope, Outbox, queryKey, type Query } from './api';
import { emptyStore, PAGE_LIMIT, reducer } from './store';
import { useLiveSync } from './useLiveSync';
import Composer, { type DraftIntent } from './Composer';
import MessageCard, { timeLabel } from './MessageCard';
import Inspector from './Inspector';
import AuthDialog from './AuthDialog';
import ExportReader from './ExportReader';
import ExportDialog from './ExportDialog';
import DiscussionView from './DiscussionView';
import { buildDiscussion } from './discussion';

function AccountDialog({ session, onClose, onFollow, onLogout }: { session: Session; onClose: () => void; onFollow: (reference: Reference) => void; onLogout: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState<string | null>(null);
  useEffect(() => { dialog.current?.showModal(); const abort = new AbortController(); void api.ledger(abort.signal).then(page => { setEntries(page.entries); setCursor(page.nextCursor); }).catch(issue => { if (!abort.signal.aborted) setError(issue.message); }).finally(() => { if (!abort.signal.aborted) setLoading(false); }); return () => abort.abort(); }, []);
  async function more() { if (!cursor || loading) return; setLoading(true); try { const page = await api.ledger(undefined, cursor); setEntries(current => [...current, ...page.entries].slice(0, 300)); setCursor(page.nextCursor); } catch (issue) { setError(issue instanceof Error ? issue.message : '读取失败'); } finally { setLoading(false); } }
  return <dialog className="account-dialog" ref={dialog} onCancel={onClose}><div className="dialog-header"><h2>{session.user.name}</h2><button type="button" className="quiet" onClick={onClose}>×</button></div><code className="user-id">{session.user.id}</code><div className="account-stats">{[['可用', session.account.available], ['锁定', session.account.locked], ['累计收入', session.account.earned], ['累计支出', session.account.spent]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><div className="ledger-list"><h3>最近收支</h3>{loading && <p role="status">正在读取…</p>}{error && <p className="error-box">{error}</p>}{entries.map(entry => <button className="ledger-entry" type="button" key={entry.id} onClick={() => { onFollow({ messageId: entry.messageId, revision: entry.messageRevision }); onClose(); }}><div><strong className={entry.amount >= 0 ? 'positive' : 'negative'}>{entry.amount > 0 ? '+' : ''}{entry.amount}</strong><span>{entry.reason}</span></div><small>{timeLabel(entry.createdAt)}</small></button>)}{cursor && entries.length < 300 && <button type="button" className="load-more" disabled={loading} onClick={() => void more()}>加载更早记录</button>}</div><button type="button" className="quiet logout" onClick={() => void onLogout().catch(issue => setError(issue.message))}>退出登录</button></dialog>;
}

export default function App() {
  const [store, dispatch] = useReducer(reducer, emptyStore);
  const storeRef = useRef(store); storeRef.current = store;
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef(session); sessionRef.current = session;
  const [rules, setRules] = useState<Rules>(DEFAULT_RULES);
  const [authOpen, setAuthOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [parent, setParent] = useState<string | undefined>();
  const [search, setSearch] = useState('');
  const [queryText, setQueryText] = useState('');
  const [relationFilter, setRelationFilter] = useState('');
  const [ownOnly, setOwnOnly] = useState(false);
  const [linear, setLinear] = useState(false);
  const [focusTarget, setFocusTarget] = useState<Reference | null>(null);
  const [sort, setSort] = useState<'recent' | 'recommendation' | 'recognition' | 'participation'>('recent');
  const [personalFilter, setPersonalFilter] = useState('all');
  const [preview, setPreview] = useState<{ targetId: string; scheme: Message } | null>(null);
  const [sentSerial, setSentSerial] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef(selectedId); selectedIdRef.current = selectedId;
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [activeRef, setActiveRef] = useState<Reference | null>(null);
  const [context, setContext] = useState<Context | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [contextRefresh, setContextRefresh] = useState(0);
  const [intent, setIntent] = useState<DraftIntent | null>(null);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [readerOpen, setReaderOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [marksError, setMarksError] = useState<string | null>(null);
  const [marksRetry, setMarksRetry] = useState(0);
  const [notificationTick, setNotificationTick] = useState(0);
  const outbox = useRef<Outbox | null>(null);
  const generation = useRef(0);
  const inflight = useRef(new Map<string, AbortController>());
  const accountRefreshTimer = useRef<number | null>(null);
  const requestedUsers = useRef(new Set<string>());
  const requestedMarks = useRef(new Set<string>());
  const notificationCursor = useRef(new Map<string, number>());
  const notificationBusy = useRef(false);
  const query = useMemo<Query>(() => ({ parent, q: queryText || undefined, relation: relationFilter || undefined, author: ownOnly ? session?.user.id : undefined, personal: session ? personalFilter === 'all' ? 'normal' : personalFilter : undefined, viewer: session?.user.id }), [parent, queryText, relationFilter, ownOnly, session?.user.id, personalFilter]);
  const queryRef = useRef(query); queryRef.current = query;
  const key = queryKey(query);
  const feed = store.feeds[key];

  const loadPage = useCallback(async (value: Query, append = false) => {
    const feedKey = queryKey(value);
    const current = storeRef.current.feeds[feedKey];
    if (append && (!current?.cursor || current.loading || current.ids.length >= PAGE_LIMIT)) return;
    inflight.current.get(feedKey)?.abort();
    const controller = new AbortController(); inflight.current.set(feedKey, controller);
    const requestGeneration = ++generation.current;
    dispatch({ type: 'begin', key: feedKey, query: value, generation: requestGeneration });
    try { const page = await api.page(value, append ? current?.cursor : null, controller.signal); if (!controller.signal.aborted) { dispatch({ type: 'page', key: feedKey, generation: requestGeneration, page, append }); if (value.personal === 'notifications' && !append) notificationCursor.current.set(feedKey, page.sequence); } }
    catch (issue) { if (!controller.signal.aborted) dispatch({ type: 'error', key: feedKey, generation: requestGeneration, error: issue instanceof Error ? issue.message : '读取失败' }); }
    finally { if (inflight.current.get(feedKey) === controller) inflight.current.delete(feedKey); }
  }, []);

  useEffect(() => {
    let disposed = false;
    void Promise.all([api.session(), api.rules()]).then(([current, activeRules]) => { if (!disposed) { setSession(current); setRules(activeRules); } }).catch(issue => { if (!disposed) setStartupError(issue.message); });
    return () => { disposed = true; for (const controller of inflight.current.values()) controller.abort(); if (accountRefreshTimer.current) window.clearTimeout(accountRefreshTimer.current); };
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => setQueryText(search.trim()), 280); return () => window.clearTimeout(timer); }, [search]);
  useEffect(() => { requestedMarks.current.clear(); setMarksError(null); dispatch({ type: 'viewer', id: session?.user.id }); }, [session?.user.id]);
  useEffect(() => { dispatch({ type: 'focus', key }); if (!storeRef.current.feeds[key] || query.personal) void loadPage(query); setChecked(new Set()); }, [key, loadPage]);
  useEffect(() => { void loadPage({ relation: 'classify' }); }, [loadPage]);
  useEffect(() => {
    if (!selectedId) { setContext(null); setContextError(null); return; }
    const controller = new AbortController();
    setContextLoading(true); setContextError(null); setContext(null);
    void api.context(selectedId, controller.signal).then(page => { if (!controller.signal.aborted) { dispatch({ type: 'context', page }); setContext(page); } }).catch(issue => { if (!controller.signal.aborted) setContextError(issue.message); }).finally(() => { if (!controller.signal.aborted) setContextLoading(false); });
    return () => controller.abort();
  }, [selectedId, contextRefresh]);
  useEffect(() => { if (!notice) return; const timer = window.setTimeout(() => setNotice(null), 4500); return () => window.clearTimeout(timer); }, [notice]);

  const receive = useCallback((change: Change) => {
    dispatch({ type: 'change', change });
    const viewer = sessionRef.current?.user.id;
    if (viewer) {
      const ids = [...new Set([...change.states.map(state => state.messageId), ...change.messages.map(message => message.id)])];
      for (let index = 0; index < ids.length; index += 100) void api.marks(ids.slice(index, index + 100)).then(page => { if (sessionRef.current?.user.id === viewer) dispatch({ type: 'personal', viewer, page }); }).catch(() => { setMarksError('个人标记暂未同步，请重新读取。'); });
      if (queryRef.current.personal === 'notifications' && change.messages.some(message => message.authorId === viewer && relations(message).some(part => ['follow', 'unfollow'].includes(part.relation)))) void loadPage(queryRef.current);
    }
    if (selectedIdRef.current && change.messages.some(message => message.id === selectedIdRef.current || relations(message).some(part => Object.values(part.roles).flat().some(binding => binding.reference.messageId === selectedIdRef.current)))) setContextRefresh(value => value + 1);
    if (!accountRefreshTimer.current) accountRefreshTimer.current = window.setTimeout(() => { accountRefreshTimer.current = null; void api.session().then(current => { setSession(current); setStartupError(null); if (current) setRules(current.rules); else void api.rules().then(setRules).catch(() => undefined); }).catch(() => undefined); }, 800);
  }, []);
  const syncStatus = useLiveSync(store.initialized, store.sequence, receive);
  const projection = useMemo(() => projectMessages(Object.values(store.messages), Object.values(store.memberships), Object.values(store.states)), [store.messages, store.memberships, store.states]);
  const personalMarks = useMemo(() => {
    const result = new Map<string, Set<string>>();
    for (const mark of Object.values(store.personalStates)) result.set(mark.messageId, new Set([...(mark.read ? ['read'] : []), ...(mark.followed ? ['follow'] : []), ...(mark.blocked ? ['block'] : []), ...(mark.archived ? ['archive'] : [])]));
    return result;
  }, [store.personalStates]);
  const displayed = useMemo(() => (feed?.ids || []).map(id => store.messages[id]).filter((message): message is Message => !!message && inQueryScope(query, store.memberships[message.id]?.parentId)).filter(message => personalFilter === 'notifications' ? true : personalFilter === 'all' ? !personalMarks.get(message.id)?.has('block') : personalFilter === 'unread' ? !personalMarks.get(message.id)?.has('read') : !!personalMarks.get(message.id)?.has(personalFilter)).sort((a, b) => sort === 'recommendation' ? (store.states[b.id]?.recommendationTotal ?? b.spending.recommendation) - (store.states[a.id]?.recommendationTotal ?? a.spending.recommendation) || b.sequence - a.sequence : sort === 'recognition' ? (store.states[b.id]?.supportCount ?? 0) - (store.states[a.id]?.supportCount ?? 0) : sort === 'participation' ? ((store.states[b.id]?.supportCount ?? 0) + (store.states[b.id]?.oppositionCount ?? 0)) - ((store.states[a.id]?.supportCount ?? 0) + (store.states[a.id]?.oppositionCount ?? 0)) : b.sequence - a.sequence), [feed?.ids, store.messages, store.memberships, store.states, parent, sort, personalFilter, personalMarks, query]);
  const neededParents = useMemo(() => displayed.filter(message => { const group = organization(message); return group && (projection.suppressed.has(message.id) || message.parts.some(part => part.type === 'display' && part.layout !== 'summary') || preview?.targetId === message.id); }).map(message => message.id).slice(0, 5), [displayed, projection.suppressed, preview]);
  useEffect(() => { for (const id of neededParents) if (!storeRef.current.feeds[queryKey({ parent: id })]) void loadPage({ parent: id }); }, [neededParents.join('|'), loadPage]);
  const categories = useMemo(() => Object.values(store.messages).filter(message => organization(message)?.relation === 'classify').sort((a, b) => b.sequence - a.sequence).slice(0, 35), [store.messages]);
  const discussion = useMemo(() => {
    const blocked = (id: string) => ['all', 'notifications'].includes(personalFilter) && store.personalStates[id]?.blocked;
    const known = new Map([...projection.byId].filter(([id]) => !blocked(id)));
    const hidden = new Set<string>();
    const displayFor = (message: Message) => (preview?.targetId === message.id ? preview.scheme : message).parts.find(part => part.type === 'display');
    const hide = (id: string) => { for (const child of projection.children.get(id) || []) { if (!hidden.has(child.id)) { hidden.add(child.id); hide(child.id); } } };
    for (const message of displayed) { const display = displayFor(message); if (organization(message) && display?.type === 'display' && display.layout === 'summary' && !projection.suppressed.has(message.id)) hide(message.id); }
    const extra = focusTarget && known.get(focusTarget.messageId);
    const focusedRelations = extra && selectedId === extra.id ? (context?.messages || []).filter(message => store.states[message.id]?.executedStance?.target.messageId === extra.id && !blocked(message.id)) : [];
    return buildDiscussion(extra ? [extra, ...displayed, ...focusedRelations] : displayed, known, store.states, message => {
      if (!organization(message)) return [];
      const display = displayFor(message);
      if (display?.type === 'display' && display.layout === 'summary' && !projection.suppressed.has(message.id)) return [];
      const order = display?.type === 'display' ? display.order || organization(message)?.roles.members?.map(binding => binding.id) || [] : [];
      const children = (projection.children.get(message.id) || []).filter(child => !blocked(child.id));
      return [...children].sort((a, b) => { const ai = order.indexOf(store.memberships[a.id]?.bindingId || ''); const bi = order.indexOf(store.memberships[b.id]?.bindingId || ''); return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi); });
    }, hidden, focusTarget?.messageId);
  }, [displayed, projection, store.states, store.personalStates, store.memberships, personalFilter, preview, focusTarget, context, selectedId]);
  const visibleMessages = useMemo(() => {
    if (!linear) return [...discussion.messages.values()];
    const visible = new Map<string, Message>();
    const add = (message: Message, depth: number) => { if (visible.has(message.id)) return; visible.set(message.id, message); if (depth < 3) for (const child of projection.children.get(message.id) || []) add(child, depth + 1); };
    for (const message of displayed) add(message, 0);
    return [...visible.values()];
  }, [displayed, projection.children, discussion, linear]);
  useEffect(() => {
    const missing = [...new Set(visibleMessages.map(message => message.authorId))].filter(id => !store.users[id] && !requestedUsers.current.has(id)).slice(0, 16);
    for (const id of missing) requestedUsers.current.add(id);
    if (missing.length) void Promise.allSettled(missing.map(id => api.user(id))).then(results => dispatch({ type: 'users', users: results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []) }));
  }, [visibleMessages, store.users]);
  useEffect(() => {
    const viewer = session?.user.id; if (!viewer) return;
    const ids = visibleMessages.map(message => message.id).filter(id => !store.personalStates[id] && !requestedMarks.current.has(`${viewer}:${id}`)).slice(0, 100);
    for (const id of ids) requestedMarks.current.add(`${viewer}:${id}`);
    if (ids.length) void api.marks(ids).then(page => { if (sessionRef.current?.user.id === viewer) dispatch({ type: 'personal', viewer, page }); }).catch(() => { setMarksError('个人标记读取失败，请重新读取。'); });
  }, [visibleMessages, session?.user.id, store.personalStates, marksRetry]);
  useEffect(() => {
    const viewer = session?.user.id; const after = notificationCursor.current.get(key);
    if (!viewer || query.personal !== 'notifications' || feed?.loading || after === undefined || after >= store.sequence || notificationBusy.current) return;
    notificationBusy.current = true;
    void (async () => {
      let cursor: string | null = null; let count = 0; let snapshot = after;
      do { const page = await api.notifications(after, cursor); if (sessionRef.current?.user.id !== viewer) return; dispatch({ type: 'notifications', key, viewer, page }); snapshot = Math.max(snapshot, page.sequence); cursor = page.nextCursor; count += page.messages.length; } while (cursor && count < PAGE_LIMIT);
      notificationCursor.current.set(key, snapshot);
    })().then(() => { notificationBusy.current = false; setNotificationTick(value => value + 1); }).catch(() => { notificationBusy.current = false; setMarksError('通知动态暂未同步，请重新读取。'); });
  }, [store.sequence, session?.user.id, key, query.personal, feed?.loading, notificationTick]);
  useEffect(() => { if (session) dispatch({ type: 'users', users: [session.user] }); }, [session?.user.id]);
  const breadcrumbs = useMemo(() => {
    const chain: Message[] = []; const seen = new Set<string>(); let id = parent;
    while (id && !seen.has(id) && chain.length < 15) { seen.add(id); const message = store.messages[id]; if (message) chain.unshift(message); id = store.memberships[id]?.parentId; }
    return chain;
  }, [parent, store.messages, store.memberships]);
  const selectedMessage = selectedId ? store.messages[selectedId] : undefined;
  const onSelect = useCallback((id: string) => { setSelectedId(id); setActiveRef({ messageId: id }); }, []);
  const onFollow = useCallback((reference: Reference) => { setSelectedId(reference.messageId); setActiveRef(reference); }, []);
  const onFocus = useCallback((reference: Reference) => { setFocusTarget(reference); setLinear(false); onFollow(reference); }, [onFollow]);
  useEffect(() => { if (focusTarget && !contextLoading) document.getElementById(`discussion-${focusTarget.messageId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, [focusTarget, contextLoading]);
  const onCheck = useCallback((id: string) => setChecked(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }), []);
  const onAction = useCallback((relation: string, targets: Reference[], data?: Json) => { setIntent({ serial: Date.now(), relation, targets, data }); document.querySelector('.composer')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, []);
  const navigate = useCallback((id?: string) => { setParent(id); setFocusTarget(null); setPersonalFilter('all'); setSearch(''); setQueryText(''); setRelationFilter(''); setSidebarOpen(false); if (id) onSelect(id); }, [onSelect]);
  async function transmit(box: Outbox): Promise<boolean> {
    setSending(true); setSendError(null);
    try {
      const result = await box.send(); dispatch({ type: 'ack', change: result.change });
      setSession(previous => previous ? { ...previous, account: result.account } : previous);
      outbox.current = null; setSentSerial(value => value + 1); setChecked(new Set()); setNotice('消息已发送'); setContextRefresh(value => value + 1); return true;
    } catch (issue) { setSendError(issue instanceof Error ? issue.message : '发送状态暂未确认，请重试'); return false; }
    finally { setSending(false); }
  }
  const send = async (input: SendInput) => {
    if (!session) { setAuthOpen(true); return false; }
    const sendingUser = session.user.id;
    const box = new Outbox(input, value => { const current = sessionRef.current; if (!current || current.user.id !== sendingUser) return Promise.reject(new Error('请使用原发送账户登录后重试')); return api.send(value, current.csrf); }); outbox.current = box; return transmit(box);
  };
  const renderCard = (message: Message, depth = 0, memberNodes?: React.ReactNode): React.ReactNode => {
    if (['all', 'notifications'].includes(personalFilter) && store.personalStates[message.id]?.blocked) return null;
    if (session && !store.personalStates[message.id]) return <div className="skeleton-card" key={message.id} role="status">正在读取个人标记…</div>;
    const group = organization(message); const suppressed = projection.suppressed.has(message.id);
    const children = [...(projection.children.get(message.id) || [])];
    const display = (preview?.targetId === message.id ? preview.scheme : message).parts.find(part => part.type === 'display');
    if (display?.type === 'display') { const order = display.order || group?.roles.members?.map(binding => binding.id) || []; if (order.length) children.sort((a, b) => { const ai = order.indexOf(store.memberships[a.id]?.bindingId || ''); const bi = order.indexOf(store.memberships[b.id]?.bindingId || ''); return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi); }); }
    const layout = display?.type === 'display' ? display.layout : group?.relation === 'arrange' ? 'row' : 'flow';
    const expand = group && (suppressed || layout !== 'summary');
    return <div key={message.id} className={`message-unit ${group ? 'organization-unit' : ''}`}><MessageCard message={message} user={store.users[message.authorId]} selected={selectedId === message.id} checked={checked.has(message.id)} suppressed={suppressed} recommendationTotal={store.states[message.id]?.recommendationTotal} supportCount={store.states[message.id]?.supportCount} oppositionCount={store.states[message.id]?.oppositionCount} mark={[...(personalMarks.get(message.id) || [])].map(value => RELATION_LABELS[value]).join(" · ")} onSelect={onSelect} onFollow={onFollow} onCheck={onCheck} onAction={onAction} onNavigate={navigate}/>{expand && depth < 3 && <div className={`organization-members layout-${suppressed ? 'flow' : layout}`}>{memberNodes ?? children.map(child => renderCard(child, depth + 1))}{store.feeds[queryKey({ parent: message.id })]?.loading && <p className="loading-note">正在展开成员…</p>}{store.feeds[queryKey({ parent: message.id })]?.error && <button type="button" onClick={() => void loadPage({ parent: message.id })}>重新读取成员</button>}{!children.length && !store.feeds[queryKey({ parent: message.id })]?.loading && <button type="button" className="quiet" onClick={() => navigate(message.id)}>查看成员 ↗</button>}{store.feeds[queryKey({ parent: message.id })]?.cursor && <button type="button" className="quiet" onClick={() => navigate(message.id)}>查看全部成员 ↗</button>}</div>}</div>;
  };

  return <div className="app-shell">
    <header className="app-header"><button type="button" className="nav-toggle" aria-label="显示导航" onClick={() => setSidebarOpen(value => !value)}>☰</button><button type="button" className="brand" onClick={() => navigate()}><span className="brand-mark">论</span><strong>公论</strong><span className="brand-caption">让讨论推进一步</span></button><label className="search-box"><span aria-hidden="true">⌕</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索消息、证据与观点" aria-label="搜索讨论"/><kbd>搜索</kbd></label><div className={`sync-state ${syncStatus}`} title={syncStatus === 'live' ? '已连接，消息会自动更新' : '正在恢复连接，已加载内容仍可查看'}><i/>{syncStatus === 'live' ? '实时同步' : syncStatus === 'recovering' ? '恢复同步中' : '连接中'}</div>{session ? <button type="button" className="account-button" onClick={() => setAccountOpen(true)}><span className="avatar">{session.user.name.slice(0, 1)}</span><span>{session.user.name}<small>{session.account.available} 贡献点</small></span></button> : <button type="button" className="primary compact" onClick={() => setAuthOpen(true)}>登录 / 加入</button>}</header>
    <div className="app-body">
      <aside className={`sidebar ${sidebarOpen ? 'mobile-open' : ''}`}><div className="sidebar-heading">讨论空间</div><button className={`nav-item ${!parent ? 'active' : ''}`} type="button" onClick={() => navigate()}><span>◈</span> 公共会场 <small>全部</small></button><button className={`nav-item ${ownOnly ? 'active' : ''}`} type="button" onClick={() => { if (!session) setAuthOpen(true); else { setPersonalFilter('all'); setOwnOnly(value => !value); } }}><span>○</span> 我的发言</button><button className={`nav-item ${personalFilter === 'notifications' ? 'active' : ''}`} type="button" onClick={() => { if (!session) setAuthOpen(true); else { navigate(); setPersonalFilter('notifications'); } }}><span>◷</span>通知与关注动态</button><div className="sidebar-heading categories-heading">分类 <button type="button" className="quiet" aria-label="创建分类" onClick={() => onAction('classify', [...checked].map(messageId => ({ messageId })))}>＋</button></div><div className="category-nav">{categories.map(category => <button key={category.id} className={`category-item ${parent === category.id ? 'active' : ''}`} type="button" onClick={() => navigate(category.id)}><span>⌑</span><span>{textOf(category).slice(0, 32) || `分类 ${category.id.slice(-5)}`}</span></button>)}{!categories.length && <p className="sidebar-note">将相关消息组织成分类，让讨论更清楚。</p>}</div><div className="sidebar-bottom"><button type="button" className="nav-item" onClick={() => setExportOpen(true)}><span>↓</span>导出记录</button><button type="button" className="nav-item" onClick={() => setReaderOpen(true)}><span>↗</span>阅览导出记录</button><div className="rules-mini"><span>当前规则 v{rules.version}</span><strong>协议费 {rules.protocolFee} 点</strong><button type="button" className="quiet" onClick={() => onAction('rule-change', [])}>讨论规则 ↗</button></div></div></aside>
      <main className="meeting"><div className="meeting-heading"><nav className="breadcrumbs" aria-label="位置"><button type="button" onClick={() => navigate()}>公共会场</button>{breadcrumbs.map(item => <span key={item.id}> / <button type="button" onClick={() => navigate(item.id)}>{textOf(item).slice(0, 22) || RELATION_LABELS[organization(item)?.relation || ''] || item.id.slice(-5)}</button></span>)}</nav><div className="title-row"><div><span className="eyebrow">PUBLIC OPINION</span><h1>{parent ? textOf(store.messages[parent] || { parts: [] } as unknown as Message).slice(0, 50) || '组织内的讨论' : queryText ? `搜索「${queryText}」` : '观点，在这里相遇。'}</h1><p>{parent ? '沿着问题展开，让每一条发言都有位置。' : '发言、举证、表态，共同形成可以继续讨论的共识。'}</p></div><div className="view-switch" aria-label="显示方式"><button type="button" className={!linear ? 'active' : ''} onClick={() => setLinear(false)}>⊞ 非线性</button><button type="button" className={linear ? 'active' : ''} onClick={() => setLinear(true)}>☰ 时间线</button></div></div></div>
        <div className="meeting-toolbar"><span>{displayed.length} 条已加载消息</span><div><select aria-label="我的标记筛选" value={personalFilter} onChange={event => { if (!session) setAuthOpen(true); else setPersonalFilter(event.target.value); }}><option value="all">正常显示</option><option value="notifications">通知与关注动态</option><option value="follow">已关注</option><option value="unread">未读</option><option value="read">已读</option><option value="archive">已冷藏</option><option value="block">已屏蔽</option></select><select aria-label="关系筛选" value={relationFilter} onChange={event => setRelationFilter(event.target.value)}><option value="">全部类型</option>{['evidence', 'question', 'agree', 'disagree', 'classify', 'summary', 'distribution', 'amend', 'delegate'].map(value => <option key={value} value={value}>{RELATION_LABELS[value]}</option>)}</select><select aria-label="排序" value={sort} onChange={event => setSort(event.target.value as typeof sort)}><option value="recent">最新发言</option><option value="recommendation">推荐投入</option><option value="recognition">认可最多</option><option value="participation">参与最多</option></select></div></div>
        {startupError && <div className="error-box" role="alert">账户状态读取失败：{startupError}<button type="button" onClick={() => window.location.reload()}>重试连接</button></div>}
        {marksError && <div className="error-box" role="alert">{marksError}<button type="button" onClick={() => { requestedMarks.current.clear(); setMarksError(null); setMarksRetry(value => value + 1); setNotificationTick(value => value + 1); void loadPage(query); }}>重新读取</button></div>}
        {preview && <div className="notice">正在预览显示方案 <button type="button" onClick={() => setPreview(null)}>结束预览</button><button type="button" onClick={() => onAction('agree', [{messageId:preview.scheme.id}])}>赞同方案</button><button type="button" onClick={() => onAction('disagree', [{messageId:preview.scheme.id}])}>反对方案</button></div>}{checked.size > 0 && <div className="selection-toolbar"><strong>已选 {checked.size} 条</strong>{['classify', 'merge', 'summary', 'arrange'].map(relation => <button type="button" key={relation} onClick={() => onAction(relation, [...checked].map(messageId => ({ messageId })))}>{RELATION_LABELS[relation]}</button>)}<button type="button" className="quiet" onClick={() => setChecked(new Set())}>取消选择</button></div>}
        <section className="discussion" aria-label="讨论消息">{feed?.error && <div className="error-box" role="alert">{feed.error}<button type="button" onClick={() => void loadPage(query)}>重新读取</button></div>}{(!feed || (feed.loading && !feed.ids.length)) && <div className="skeleton-grid" aria-label="正在读取消息">{[0, 1, 2].map(index => <div className="skeleton-card" key={index}><i/><i/><i/></div>)}</div>}
          {feed && !feed.loading && !feed.error && !displayed.length && <div className="empty-meeting"><span>◌</span><h2>{queryText || relationFilter ? '没有找到匹配的消息' : '从一个值得讨论的问题开始'}</h2><p>{queryText || relationFilter ? '换个关键词，或调整筛选条件。' : '写下你的观点、疑问或证据。第一条发言，就能开启会议。'}</p></div>}
          {focusTarget && <div className="notice">{contextLoading ? '正在读取所指消息…' : '正在查看所指消息及已加载的关联'}<button type="button" onClick={() => setFocusTarget(null)}>收起聚焦</button>{contextError && <button type="button" onClick={() => setContextRefresh(value => value + 1)}>重新读取</button>}</div>}
          {(displayed.length > 0 || discussion.roots.length > 0) && (linear ? <div className="linear-feed">{displayed.map(message => renderCard(message))}</div> : <DiscussionView model={discussion} renderMessage={(message, members) => renderCard(message, 0, members)} onFocus={onFocus}/>)}
          {feed?.cursor && <button type="button" className="load-more" disabled={feed.loading} onClick={() => void loadPage(query, true)}>{feed.loading ? '读取中…' : '加载更多消息'}</button>}{(feed?.ids.length || 0) >= PAGE_LIMIT && <p className="section-note">已加载 300 条。可以通过搜索或分类缩小范围。</p>}
        </section>
        <Composer session={session} rules={rules} parent={parent} intent={intent} messages={store.messages} busy={sending} retryError={sendError} sentSerial={sentSerial} selectedReference={activeRef} onSend={send} onRetry={() => { if (outbox.current) void transmit(outbox.current); }} onDiscard={() => { outbox.current = null; setSendError(null); }} onLogin={() => setAuthOpen(true)}/>
      </main>
      <Inspector message={selectedMessage} context={context} loading={contextLoading} error={contextError} user={selectedMessage ? store.users[selectedMessage.authorId] : undefined} session={session} activeRef={activeRef} onReference={setActiveRef} onSelect={onSelect} onFollow={onFollow} onAction={onAction} onClose={() => setSelectedId(null)} onReload={() => setContextRefresh(value => value + 1)} onPreview={(targetId, scheme) => setPreview({targetId, scheme})}/>
    </div>
    {notice && <div className="toast" role="status">{notice}</div>}
    {exportOpen && <ExportDialog onClose={() => setExportOpen(false)}/>} {readerOpen && <ExportReader onClose={() => setReaderOpen(false)}/>} {authOpen && <AuthDialog onClose={() => setAuthOpen(false)} onSession={value => { setSession(value); setRules(value.rules); }}/>} {accountOpen && session && <AccountDialog session={session} onClose={() => setAccountOpen(false)} onFollow={onFollow} onLogout={async () => { await api.logout(session.csrf); setSession(null); setOwnOnly(false); setAccountOpen(false); }}/>} 
  </div>;
}



