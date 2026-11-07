import { useCallback, useEffect, useState } from 'react';
import type { ManagedAccount, RegistrationInvite } from '@gonglun/core';
import { createAdminInvite, getAdminAccounts, getAdminInvites, revokeAdminInvite, setAdminAccountDisabled } from '../api/client';
import PromptModal from './PromptModal';
import { dialogStyles } from './dialogStyles';

const statusLabels = { available: '未使用', used: '已使用', expired: '已过期', revoked: '已撤销' };
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { hour12: false });
const rowStyle = { borderBottom: '1px solid var(--dialog-border)', padding: '12px 0' };

export default function AccessManagementModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<'invites' | 'accounts'>('invites');
  const [invites, setInvites] = useState<RegistrationInvite[]>([]);
  const [accounts, setAccounts] = useState<ManagedAccount[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [days, setDays] = useState('7');
  const [generated, setGenerated] = useState<{code:string;invite:RegistrationInvite} | null>(null);
  const [pendingDisable, setPendingDisable] = useState<ManagedAccount | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async (before?: string, signal?: AbortSignal) => {
    setLoading(true);
    setError('');
    try {
      if (tab === 'invites') {
        const page = await getAdminInvites(before, signal);
        if (signal?.aborted) return;
        setInvites(previous => before ? [...previous, ...page.items] : page.items);
        setCursor(page.nextCursor);
      } else {
        const page = await getAdminAccounts(query, before, signal);
        if (signal?.aborted) return;
        setAccounts(previous => before ? [...previous, ...page.items] : page.items);
        setCursor(page.nextCursor);
      }
    } catch (err) {
      if (!signal?.aborted) setError(err instanceof Error ? err.message : '加载失败，请重试');
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [tab, query]);

  useEffect(() => {
    const controller = new AbortController();
    setCursor(null);
    setPendingDisable(null);
    void load(undefined, controller.signal);
    return () => controller.abort();
  }, [load]);

  async function act(work: () => Promise<void>) {
    if (busy || loading) return;
    setBusy(true); setError(''); setNotice('');
    try { await work(); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : '操作失败，请重试'); }
    finally { setBusy(false); }
  }
  const unavailable = busy || loading;
  const close = () => { if (!busy) onClose(); };

  return <PromptModal open title="注册与账号管理" hideActions onConfirm={close} onCancel={close} onClose={close}
    dialogProps={{style:{width:'min(680px, calc(100vw - 24px))'}}}
    message={<div style={{whiteSpace:'normal'}}>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:16}}>
        <button type="button" aria-pressed={tab === 'invites'} disabled={unavailable} style={tab === 'invites' ? dialogStyles.primaryButton : dialogStyles.button} onClick={() => setTab('invites')}>邀请码</button>
        <button type="button" aria-pressed={tab === 'accounts'} disabled={unavailable} style={tab === 'accounts' ? dialogStyles.primaryButton : dialogStyles.button} onClick={() => setTab('accounts')}>账号</button>
        <button type="button" disabled={unavailable} style={{...dialogStyles.button,marginLeft:'auto'}} onClick={() => void load()}>刷新列表</button>
      </div>
      {error && <p role="alert" style={{color:'var(--ink-ef4444)',marginBottom:12}}>{error}</p>}
      {notice && <p role="status" style={{marginBottom:12}}>{notice}</p>}
      {tab === 'invites' ? <>
        <form onSubmit={event => {
          event.preventDefault();
          const value = Number(days);
          if (!Number.isInteger(value) || value < 1 || value > 365) { setError('有效期须为 1 到 365 天'); return; }
          void act(async () => { setGenerated(await createAdminInvite(value)); setNotice('邀请码已生成，请复制后交给受邀者。'); });
        }} style={{display:'flex',alignItems:'end',gap:12,flexWrap:'wrap'}}>
          <label style={{flex:'1 1 180px'}}>有效期（天）
            <input aria-label="有效期（天）" type="number" min="1" max="365" step="1" required value={days} onChange={event => setDays(event.target.value)} style={dialogStyles.input} disabled={unavailable} />
          </label>
          <button type="submit" disabled={unavailable} style={dialogStyles.primaryButton}>生成邀请码</button>
        </form>
        <p style={{fontSize:12,margin:'8px 0 12px'}}>每个邀请码只能使用一次。完整邀请码仅在生成后显示，请及时保存。</p>
        {generated && <div style={{padding:12,border:'1px solid var(--dialog-border)',marginBottom:16}}>
          <label>新邀请码<input aria-label="新邀请码" readOnly value={generated.code} onFocus={event => event.currentTarget.select()} style={{...dialogStyles.input,fontFamily:'monospace'}} /></label>
          <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginTop:8}}>
            <span style={{flex:1,fontSize:12}}>到期：{date(generated.invite.expiresAt)}</span>
            <button type="button" style={dialogStyles.button} onClick={() => {
              if (!navigator.clipboard) { setError('当前浏览器无法自动复制，请选中邀请码手动复制。'); return; }
              void navigator.clipboard.writeText(generated.code).then(() => {setError('');setNotice('邀请码已复制');}).catch(() => setError('复制失败，请选中邀请码手动复制。'));
            }}>复制邀请码</button>
          </div>
        </div>}
        <div aria-label="邀请码列表" aria-busy={loading}>
          {invites.map(invite => <div key={invite.id} style={rowStyle}>
            <div style={{display:'flex',alignItems:'center',gap:12,flexWrap:'wrap'}}>
              <code style={{flex:1}}>{invite.hint}</code><span>{statusLabels[invite.status]}</span>
              {invite.status === 'available' && <button type="button" disabled={unavailable} style={dialogStyles.button} aria-label={`撤销邀请码 ${invite.hint}`} onClick={() => void act(async () => {
                await revokeAdminInvite(invite.id);
                if (generated?.invite.id === invite.id) setGenerated(null);
                setNotice('邀请码已撤销');
              })}>撤销</button>}
            </div>
            <p style={{fontSize:12,marginTop:4}}>生成：{date(invite.createdAt)} · 到期：{date(invite.expiresAt)}</p>
            {invite.usedAt && <p style={{fontSize:12}}>使用者：{invite.usedByName ?? invite.usedBy} · {date(invite.usedAt)}</p>}
            {invite.revokedAt && <p style={{fontSize:12}}>撤销：{date(invite.revokedAt)}</p>}
          </div>)}
          {!loading && !invites.length && <p style={{padding:'20px 0'}}>暂无邀请码</p>}
        </div>
      </> : <>
        <form onSubmit={event => {event.preventDefault();setQuery(search.trim());}} style={{display:'flex',gap:8,marginBottom:12}}>
          <input aria-label="搜索账号" placeholder="按用户名搜索" value={search} maxLength={40} onChange={event => setSearch(event.target.value)} style={dialogStyles.input} disabled={busy} />
          <button type="submit" disabled={unavailable} style={{...dialogStyles.button,flexShrink:0}}>搜索</button>
        </form>
        {pendingDisable && <div role="alert" style={{padding:12,border:'1px solid var(--dialog-border)',marginBottom:12}}>
          <p>停用“{pendingDisable.name}”？该账号所有设备将退出登录，不能继续参与。历史消息和贡献点记录保留。</p>
          <div style={{display:'flex',gap:8,marginTop:8}}>
            <button type="button" disabled={unavailable} style={dialogStyles.primaryButton} onClick={() => void act(async () => {
              await setAdminAccountDisabled(pendingDisable.id,true);setPendingDisable(null);setNotice('账号已停用，全部登录会话已失效');
            })}>确认停用</button>
            <button type="button" disabled={busy} style={dialogStyles.button} onClick={() => setPendingDisable(null)}>取消</button>
          </div>
        </div>}
        <div aria-label="账号列表" aria-busy={loading}>
          {accounts.map(account => <div key={account.id} style={rowStyle}>
            <div style={{display:'flex',alignItems:'center',gap:12,flexWrap:'wrap'}}>
              <strong style={{flex:1,overflowWrap:'anywhere'}}>{account.name}</strong>
              <span>{account.founder ? '管理员' : account.disabledAt ? '已停用' : '正常'}</span>
              {!account.founder && <button type="button" disabled={unavailable} style={dialogStyles.button} aria-label={`${account.disabledAt ? '恢复' : '停用'}账号 ${account.name}`} onClick={() => {
                if (!account.disabledAt) {setPendingDisable(account);return;}
                void act(async () => {await setAdminAccountDisabled(account.id,false);setNotice('账号已恢复，请用户重新登录');});
              }}>{account.disabledAt ? '恢复' : '停用'}</button>}
            </div>
            <p style={{fontSize:12,marginTop:4}}>注册：{date(account.createdAt)}{account.disabledAt && ` · 停用：${date(account.disabledAt)}`}</p>
          </div>)}
          {!loading && !accounts.length && <p style={{padding:'20px 0'}}>未找到账号</p>}
        </div>
      </>}
      {loading && <p role="status" style={{padding:'12px 0'}}>正在加载…</p>}
      {cursor && <button type="button" disabled={unavailable} style={{...dialogStyles.button,width:'100%',marginTop:12}} onClick={() => void load(cursor)}>加载更多</button>}
      <button type="button" disabled={busy} style={{...dialogStyles.button,width:'100%',marginTop:20}} onClick={close}>关闭</button>
    </div>} />;
}
