import { useEffect, useRef, useState } from 'react';
import type { Session } from '@gonglun/core';
import { api } from './api';

export default function AuthDialog({ onClose, onSession }: { onClose: () => void; onSession: (session: Session) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [founderKeyRequired, setFounderKeyRequired] = useState(false);
  const [founderKey, setFounderKey] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); let active = true; void api.setup().then(setup => { if (active) setFounderKeyRequired(!setup.initialized && setup.founderKeyRequired); }).catch(() => undefined); return () => { active = false; }; }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setPending(true); setError(null);
    try { const session = await api.login(mode, name, password, mode === 'register' ? founderKey : undefined); onSession(session); onClose(); }
    catch (issue) { setError(issue instanceof Error ? issue.message : '暂时无法登录'); }
    finally { setPending(false); }
  }
  return <dialog className="auth-dialog" ref={dialog} onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}><form onSubmit={submit}><button type="button" className="dialog-close" aria-label="关闭登录" onClick={onClose}>×</button><span className="brand-mark">论</span><h2>{mode === 'login' ? '回到讨论中' : '加入公论'}</h2><p>用发言推进会议，让贡献获得回报。</p><label>用户名<input required autoFocus autoComplete="username" value={name} onChange={event => setName(event.target.value)} maxLength={40}/></label><label>密码<input required type="password" minLength={8} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={event => setPassword(event.target.value)} placeholder="至少 8 位"/></label>{mode === 'register' && founderKeyRequired && <label>初始化密钥<input required type="password" autoComplete="off" value={founderKey} onChange={event => setFounderKey(event.target.value)} placeholder="由部署者提供"/></label>}{error && <div className="error-box" role="alert">{error}</div>}<button className="primary" type="submit" disabled={pending}>{pending ? '请稍候…' : mode === 'login' ? '登录' : '注册并加入'}</button><button className="quiet auth-switch" type="button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}>{mode === 'login' ? '还没有账户？注册' : '已有账户？登录'}</button></form></dialog>;
}
