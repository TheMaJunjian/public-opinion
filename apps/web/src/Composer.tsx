import { useEffect, useMemo, useRef, useState } from 'react';
import { RELATION_LABELS, ORGANIZATIONS, bindRoles, referenceKey, replaceReference, resolveReference, type Json, type Message, type Part, type Reference, type Rules, type SendInput, type Session } from '@gonglun/core';

export interface DraftIntent { serial: number; relation: string; targets: Reference[]; data?: Json }
interface Props {
  session: Session | null; rules: Rules; parent?: string; intent: DraftIntent | null;
  messages: Record<string, Message>; busy: boolean; retryError: string | null;
  sentSerial: number;
  selectedReference: Reference | null;
  onSend: (input: SendInput) => Promise<boolean>; onRetry: () => void; onDiscard: () => void; onLogin: () => void;
}

const operations = [
  ['讨论', ['reply', 'evidence', 'question', 'answer', 'reference', 'annotation', 'agree', 'disagree', 'tag', 'low-quality']],
  ['组织', ['classify', 'merge', 'summary', 'arrange', 'member-of', 'presentation']],
  ['推进', ['amend', 'authorize', 'terminate', 'delegate', 'fulfill', 'rule-change', 'distribute', 'credit', 'recharge', 'release']],
  ['标记', ['recommend', 'follow', 'unfollow', 'read', 'unread', 'archive', 'unarchive', 'block', 'unblock', 'notify']],
] as const;
const noTarget = new Set(['message', 'classify', 'merge', 'summary', 'arrange', 'rule-change', 'delegate', 'distribute', 'credit', 'recharge', 'release']);
const short = (id: string) => id.slice(-7);

export default function Composer({ session, rules, parent, intent, messages, busy, retryError, sentSerial, selectedReference, onSend, onRetry, onDiscard, onLogin }: Props) {
  const [relation, setRelation] = useState('message');
  const [format, setFormat] = useState<'text' | 'web' | 'code'>('text');
  const [body, setBody] = useState('');
  const [url, setUrl] = useState('');
  const [language, setLanguage] = useState('javascript');
  const [targets, setTargets] = useState<Reference[]>([]);
  const [layout, setLayout] = useState<'flow' | 'columns' | 'row' | 'summary'>('flow');
  const [recommendation, setRecommendation] = useState(0);
  const [wager, setWager] = useState(0);
  const [amount, setAmount] = useState(10);
  const [recipient, setRecipient] = useState('');
  const [label, setLabel] = useState('');
  const [customRelation, setCustomRelation] = useState('');
  const [ruleJson, setRuleJson] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [extraData, setExtraData] = useState<Json | undefined>();
  const [expanded, setExpanded] = useState(false);
  const textArea = useRef<HTMLTextAreaElement>(null);
  const targetValue = useMemo(() => targets[0] ? resolveReference(targets[0], id => messages[id]) : undefined, [targets, messages]);
  useEffect(() => { if (sentSerial) { setBody(''); setTargets([]); setWager(0); setRecommendation(0); setRelation('message'); setExpanded(false); setExtraData(undefined); } }, [sentSerial]);

  useEffect(() => {
    if (!intent) return;
    setRelation(intent.relation);
    setExtraData(intent.data);
    setTargets(Array.from(new Map(intent.targets.map(ref => [referenceKey(ref), ref])).values()));
    setExpanded(true);
    setError(null);
    setWager(0);
    if (ORGANIZATIONS.has(intent.relation)) setLayout(intent.relation === 'summary' ? 'summary' : intent.relation === 'arrange' ? 'row' : 'flow');
    if (intent.relation === 'amend' && intent.targets[0]) {
      const ref = intent.targets[0];
      const value = resolveReference(ref, id => messages[id]);
      if (typeof value === 'string') setBody(value);
      else if (value && typeof value === 'object' && 'type' in value) {
        const part = value as Part;
        setBody(part.type === 'text' ? part.text : part.type === 'web' ? part.excerpt : part.type === 'code' ? part.source : JSON.stringify(value, null, 2));
      } else if (!ref.partId) setBody(JSON.stringify(messages[ref.messageId]?.parts ?? [], null, 2));
      else setBody(JSON.stringify(value, null, 2) ?? '');
    }
    window.setTimeout(() => textArea.current?.focus(), 0);
  }, [intent]);

  function amendValue(): Json {
    const ref = targets[0];
    const original = ref && messages[ref.messageId];
    if (!original) throw new Error('请先选择要修改的消息或部件');
    if (ref.revision && ref.revision !== original.revision) throw new Error('请返回当前版本再提出修改，历史版本保持可引用');
    let replacement: unknown;
    if (typeof targetValue === 'string') replacement = body;
    else if (targetValue && typeof targetValue === 'object' && 'type' in targetValue && !ref.path?.length && !ref.range) {
      const part = targetValue as Part;
      replacement = part.type === 'text' ? { ...part, text: body } : part.type === 'web' ? { ...part, excerpt: body } : part.type === 'code' ? { ...part, source: body } : JSON.parse(body);
    } else replacement = JSON.parse(body);
    replaceReference(original, ref, replacement);
    return replacement as Json;
  }

  async function submit(event?: React.FormEvent) {
    event?.preventDefault();
    if (!session) { onLogin(); return; }
    if (busy || retryError) return;
    setError(null);
    try {
      if (!noTarget.has(relation) && targets.length === 0) throw new Error('请从消息卡片或右侧详情选择目标');
      if (relation === 'message' && !body.trim()) throw new Error('写下你想推进的讨论');
      if (format === 'web' && relation !== 'amend' && !/^https?:\/\//i.test(url)) throw new Error('网页地址需要以 https:// 或 http:// 开头');
      const parts: Part[] = [];
      if (relation === 'amend') {
        if (targets.length !== 1) throw new Error('一次修改请选择一个目标');
        parts.push({ id: 'change', type: 'relation', relation: 'amend', roles: bindRoles({ target: [targets[0]] }) });
        const replacement = amendValue();
        parts.push({ id: 'proposal', type: 'data', value: { expectedRevision: messages[targets[0].messageId].revision, ...(targets[0].partId ? { value: replacement } : { parts: replacement }) } });
      } else {
        if (body.trim()) parts.push(format === 'web' ? { id: 'content', type: 'web', url, excerpt: body } : format === 'code' ? { id: 'content', type: 'code', language, source: body } : { id: 'content', type: 'text', text: body });
        if (relation !== 'message') {
          const roles: Record<string, Reference[]> = ORGANIZATIONS.has(relation) ? { members: targets } : relation === 'member-of' ? { parent: targets } : targets.length ? { target: targets } : {};
          const actualRelation = relation === 'custom' ? customRelation.trim() : relation;
          if (!actualRelation) throw new Error('请填写关系名称');
          parts.push({ id: 'relation', type: 'relation', relation: actualRelation, roles: bindRoles(roles) });
          if (ORGANIZATIONS.has(relation)) parts.push({ id: 'display', type: 'display', relationPartId: 'relation', layout });
          if (relation === 'presentation') parts.push({ id: 'display', type: 'display', relationPartId: 'relation', target: targets[0], layout });
          if (relation === 'tag') { if (!label.trim()) throw new Error('请填写标注'); parts.push({ id: 'details', type: 'data', value: { label } }); }
          if (relation === 'delegate') parts.push({ id: 'details', type: 'data', value: { reward: amount } });
          if (relation === 'credit') { if (!recipient.trim()) throw new Error('请填写接收者编号'); parts.push({ id: 'details', type: 'data', value: { userId: recipient, amount } }); }
          if (relation === 'recharge') parts.push({ id: 'details', type: 'data', value: { amount } });
          if (relation === 'rule-change') parts.push({ id: 'details', type: 'data', value: JSON.parse(ruleJson || '{}') });
          if (relation === 'terminate' && extraData) parts.push({ id: 'details', type: 'data', value: extraData });
        }
      }
      if (parent && relation !== 'member-of') parts.push({ id: 'membership', type: 'relation', relation: 'member-of', roles: bindRoles({ parent: [{ messageId: parent }] }) });
      const accepted = await onSend({ requestId: crypto.randomUUID(), parts, recommendation, wager });
      if (accepted) { setBody(''); setTargets([]); setWager(0); setRecommendation(0); setRelation('message'); setExpanded(false); }
    } catch (issue) { setError(issue instanceof Error ? issue.message : '消息内容有误'); }
  }

  return <form className={`composer ${expanded ? 'is-expanded' : ''}`} onSubmit={submit} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void submit(); } }}>
    <div className="composer-top"><span className="eyebrow">推进这场讨论</span><button type="button" className="quiet" onClick={() => setExpanded(value => !value)}>{expanded ? '收起设置' : '更多操作'} <span aria-hidden="true">⌄</span></button></div>
    <fieldset disabled={busy || !!retryError}>
      <div className="composer-controls"><label className="sr-only" htmlFor="operation">发送方式</label><select id="operation" value={relation} onChange={event => { setRelation(event.target.value); setExpanded(true); setWager(0); }}><option value="message">发言</option>{operations.map(([group, values]) => <optgroup key={group} label={group}>{values.map(value => <option key={value} value={value}>{RELATION_LABELS[value] || (value === 'presentation' ? '显示方案' : value === 'unarchive' ? '取消冷藏' : value)}</option>)}</optgroup>)}<option value="custom">其他关系</option></select>
        {relation !== 'amend' && <><label className="sr-only" htmlFor="format">内容格式</label><select id="format" value={format} onChange={event => setFormat(event.target.value as typeof format)}><option value="text">文本</option><option value="web">网页摘录</option><option value="code">代码</option></select></>}
        {(ORGANIZATIONS.has(relation) || relation === 'presentation') && <select aria-label="组织显示方式" value={layout} onChange={event => setLayout(event.target.value as typeof layout)}><option value="flow">依次展开</option><option value="columns">分列</option><option value="row">并排</option><option value="summary">总结覆盖</option></select>}
      </div>
      {targets.length > 0 && <div className="target-list">{targets.map((target, index) => <span className="target-pill" key={referenceKey(target)}>↗ {short(target.messageId)}{target.partId ? ` · ${target.partId}` : ''}{target.path?.length ? ` / ${target.path.join('.')}` : ''}{target.range ? ` [${target.range.start}–${target.range.end}]` : ''}{target.revision ? ` · v${target.revision}` : ' · 当前'}<button type="button" aria-label="移除目标" onClick={() => setTargets(previous => previous.filter((_, i) => i !== index))}>×</button></span>)}</div>}
      {selectedReference && !targets.some(target => referenceKey(target) === referenceKey(selectedReference)) && <button className="attach-selection" type="button" onClick={() => { setTargets(previous => [...previous, selectedReference]); if (relation === 'message') setRelation('reference'); }}>＋ 引用选中的{selectedReference.partId ? '部件' : '消息'}</button>}
      {format === 'web' && relation !== 'amend' && <input aria-label="网页地址" type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://…"/>}
      {format === 'code' && relation !== 'amend' && <input aria-label="代码语言" value={language} onChange={event => setLanguage(event.target.value)} placeholder="代码语言"/>}
      <textarea ref={textArea} aria-label={relation === 'amend' ? '修改后的内容' : '消息内容'} value={body} onChange={event => setBody(event.target.value)} onFocus={() => setExpanded(true)} rows={expanded ? 4 : 2} placeholder={relation === 'amend' ? '修改后的内容' : relation === 'agree' || relation === 'disagree' ? '说明你的理由（可选）' : '一个观点、一份证据，或一个值得讨论的问题…'}/>
      {expanded && <div className="composer-details">
        {relation === 'custom' && <label>关系名称<input value={customRelation} onChange={event => setCustomRelation(event.target.value)} placeholder="例如：反例"/></label>}{relation === 'tag' && <label>标注<input value={label} onChange={event => setLabel(event.target.value)} placeholder="例如：关键证据"/></label>}
        {['delegate', 'credit', 'recharge'].includes(relation) && <label>{relation === 'delegate' ? '委托报酬' : '贡献点数量'}<input type="number" min="1" step="1" value={amount} onChange={event => setAmount(Number(event.target.value))}/></label>}
        {relation === 'credit' && <label>接收者编号<input value={recipient} onChange={event => setRecipient(event.target.value)} placeholder="用户编号"/></label>}
        {relation === 'rule-change' && <label className="wide">规则修改<textarea aria-label="规则修改内容" rows={5} value={ruleJson} onChange={event => setRuleJson(event.target.value)} placeholder={'{ "protocolFee": 1, "settlementDelayMs": 60000 }'}/><button type="button" className="quiet" onClick={() => { const { version: _, ...values } = rules; setRuleJson(JSON.stringify(values, null, 2)); }}>填入当前规则</button></label>}
        <label>推荐投入<input type="number" min="0" step="1" value={recommendation} onChange={event => setRecommendation(Number(event.target.value))}/></label>
        <label>对赌投入<input type="number" min="0" step="1" value={wager} onChange={event => setWager(Number(event.target.value))}/></label>
      </div>}
    </fieldset>
    {(error || retryError) && <div className="error-box" role="alert">{retryError || error}{retryError && <div className="inline-actions"><button type="button" onClick={onRetry} disabled={busy}>{busy ? '正在确认…' : '重试同一条消息'}</button><button type="button" onClick={() => { onDiscard(); setError(null); }}>取消重试</button></div>}</div>}
    <div className="composer-footer"><span className="cost">协议费 <strong>{rules.protocolFee}</strong>{recommendation > 0 && <> · 推荐 {recommendation}</>}{wager > 0 && <> · 对赌 {wager}</>}<span className="shortcut">Ctrl ↵</span></span><button className="primary" type="submit" disabled={busy || !!retryError}>{busy ? '正在发送…' : session ? '发送消息 ↗' : '登录后发言'}</button></div>
  </form>;
}
