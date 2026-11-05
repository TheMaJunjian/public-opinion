import { useCallback, useContext, useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getSetup, storePrivateKeyForUser } from '../api/client';
import { generateSigningKeyPair } from '../utils/signature';
import PromptModal from '../components/PromptModal';
import { dialogStyles } from '../components/dialogStyles';
import { AutoAuthEntryContext } from '../context/AutoAuthEntryContext';

export default function RegisterPage({ onClose, onLogin, onSuccess, closeText = '返回首页' }: {
  onClose?: () => void;
  onLogin?: () => void;
  onSuccess?: () => void;
  closeText?: string;
} = {}) {
  const { register } = useAuth();
  const autoAuthEntry = useContext(AutoAuthEntryContext);
  const suspended = autoAuthEntry?.suspended ?? false;
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [founderKeyRequired, setFounderKeyRequired] = useState(false);
  const [founderKey, setFounderKey] = useState('');
  const close = useCallback(() => onClose ? onClose() : navigate('/', { replace: true }), [navigate, onClose]);

  useEffect(() => {
    if (suspended) return;
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [close, suspended]);

  useEffect(() => {
    let active = true;
    void getSetup().then(setup => {
      if (active) setFounderKeyRequired(!setup.initialized && setup.founderKeyRequired);
    }).catch(err => { if (active) setError(err instanceof Error ? err.message : '无法确认站点初始化状态，请刷新重试'); });
    return () => { active = false; };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const normalizedUsername = username.trim();
    if (!normalizedUsername || !password) { setError('请填写与会者名和密码'); return; }
    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,30}$/.test(normalizedUsername)) {
      setError('与会者名需为 2-30 位字母、数字、下划线或汉字（不含空格和标点）');
      return;
    }
    if (founderKeyRequired && !founderKey.trim()) { setError('请填写初始发起人密钥'); return; }
    setError('');
    setLoading(true);
    try {
      const keyPair = await generateSigningKeyPair();
      const jwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
      storePrivateKeyForUser(normalizedUsername, jwk);
      const pubJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
      const publicKey = JSON.stringify(pubJwk);

      await register(normalizedUsername, password, publicKey, founderKeyRequired ? founderKey.trim() : undefined);
      localStorage.setItem('registration-guide-pending', 'true');
      if (onSuccess) onSuccess();
      else navigate('/');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '注册失败，请重试');
    } finally {
      setLoading(false);
    }
  }

  return (
    <PromptModal open title="注册公论" hideActions onConfirm={() => {}} onCancel={close} onClose={close}
      dialogProps={{ style: { width: 'min(400px, 100%)' } }} message={<div style={{ whiteSpace: 'normal' }}>
        <p className="text-center text-[color:var(--ink-d1d5db)] text-sm mb-6">创建您的与会者账户，参与公论</p>
        {error && (
          <div role="alert" className="bg-[color:var(--surface-450a0a)] border border-[color:var(--line-991b1b)] text-[color:var(--ink-fecaca-2)] rounded px-3 py-2 text-sm mb-4">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="register-username" className="block text-sm font-medium text-[color:var(--ink-e5e7eb-2)] mb-1">与会者名</label>
            <input
              id="register-username"
              type="text"
              name="username"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="2-30位字母、数字、下划线或汉字"
              className="auth-input"
            />
          </div>
          <div>
            <label htmlFor="register-password" className="block text-sm font-medium text-[color:var(--ink-e5e7eb-2)] mb-1">密码</label>
            <input
              id="register-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="请输入密码"
              className="auth-input"
            />
          </div>
          {founderKeyRequired && <div>
            <label htmlFor="founder-key" className="block text-sm font-medium text-[color:var(--ink-e5e7eb-2)] mb-1">初始发起人密钥</label>
            <input id="founder-key" type="password" autoComplete="off" value={founderKey}
              onChange={e => setFounderKey(e.target.value)}
              placeholder="站点首次初始化时需要"
              className="auth-input" />
          </div>}
          <button
            type="submit"
            disabled={loading}
            style={{ ...dialogStyles.primaryButton, padding: '9px 14px' }}
            className="w-full disabled:opacity-50 disabled:cursor-wait"
          >
            {loading ? '注册中…' : '注册账户'}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-[color:var(--ink-9ca3af)]">
          已有账户？{' '}
          {onLogin
            ? <button type="button" onClick={onLogin} className="text-[color:var(--ink-60a5fa-2)] hover:underline font-medium">立即登录</button>
            : <Link to="/login" className="text-[color:var(--ink-60a5fa-2)] hover:underline font-medium">立即登录</Link>}
        </p>
        <button type="button" onClick={close} style={{ ...dialogStyles.button, width: '100%', marginTop: 16 }}>{closeText}</button>
      </div>} />
  );
}
