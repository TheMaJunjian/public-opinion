import { useCallback, useContext, useEffect, useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import PromptModal from '../components/PromptModal';
import { dialogStyles } from '../components/dialogStyles';
import { AutoAuthEntryContext } from '../context/AutoAuthEntryContext';
import { authReturnPath } from '../utils/authReturnPath';

export default function LoginPage({ onClose, onRegister, onSuccess, closeText = '返回首页' }: {
  onClose?: () => void;
  onRegister?: () => void;
  onSuccess?: () => void;
  closeText?: string;
} = {}) {
  const { login } = useAuth();
  const autoAuthEntry = useContext(AutoAuthEntryContext);
  const suspended = autoAuthEntry?.suspended ?? false;
  const navigate = useNavigate();
  const location = useLocation();
  const redirectReason = (location.state as any)?.reason as string | undefined;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const close = useCallback(() => onClose ? onClose() : navigate('/', { replace: true }), [navigate, onClose]);
  useEffect(() => {
    if (suspended) return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [close, suspended]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) { setError('请填写与会者名和密码'); return; }
    setError('');
    setLoading(true);
    try {
      await login(username.trim(), password);
      if (onSuccess) onSuccess();
      else navigate(authReturnPath(location.state), { replace: true });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '登录失败，请重试');
    } finally {
      setLoading(false);
    }
  }

  return (
    <PromptModal open title={redirectReason ? '请先登录' : '登录公论'} hideActions onConfirm={() => {}} onCancel={close} onClose={close}
      dialogProps={{ style: { width: 'min(400px, 100%)' } }} message={<div style={{ whiteSpace: 'normal' }}>
        <p className="text-center text-[color:var(--ink-d1d5db)] text-sm mb-6">登录您的与会者账户，参与公论</p>
        {redirectReason && (
          <div role="status" className="bg-[color:var(--surface-451a03)] border border-[color:var(--line-92400e)] text-[color:var(--ink-fde68a-2)] rounded-lg px-3 py-2 text-sm mb-4">
            {redirectReason}
          </div>
        )}
        {error && (
          <div role="alert" className="bg-[color:var(--surface-450a0a)] border border-[color:var(--line-991b1b)] text-[color:var(--ink-fecaca-2)] rounded-lg px-3 py-2 text-sm mb-4">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="login-username" className="block text-sm font-medium text-[color:var(--ink-e5e7eb-2)] mb-1">与会者名</label>
            <input
              id="login-username"
              type="text"
              name="username"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="请输入与会者名"
              className="auth-input"
            />
          </div>
          <div>
            <label htmlFor="login-password" className="block text-sm font-medium text-[color:var(--ink-e5e7eb-2)] mb-1">密码</label>
            <input
              id="login-password"
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="请输入密码"
              className="auth-input"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            style={{ ...dialogStyles.primaryButton, padding: '9px 14px' }}
            className="w-full disabled:opacity-50 disabled:cursor-wait"
          >
            {loading ? '登录中…' : '登录'}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-[color:var(--ink-9ca3af)]">
          还没有账户？{' '}
          {onRegister
            ? <button type="button" onClick={onRegister} className="text-[color:var(--ink-60a5fa-2)] hover:underline font-medium">立即注册</button>
            : <Link to="/register" state={location.state} className="text-[color:var(--ink-60a5fa-2)] hover:underline font-medium">立即注册</Link>}
        </p>
        <button type="button" onClick={() => { close(); window.dispatchEvent(new Event('open-export-viewer')); }}
          style={{ ...dialogStyles.button, width: '100%', marginTop: 16 }}>离线使用本地消息文件</button>
        <button type="button" onClick={close} style={{ ...dialogStyles.button, width: '100%', marginTop: 16 }}>{closeText}</button>
      </div>} />
  );
}
