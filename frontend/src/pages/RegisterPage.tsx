import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { getSetup, storePrivateKeyForUser } from '../api/client';
import { generateSigningKeyPair } from '../utils/signature';

export default function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [founderKeyRequired, setFounderKeyRequired] = useState(false);
  const [founderKey, setFounderKey] = useState('');

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
      navigate('/');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '注册失败，请重试');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-[color:var(--surface-f9fafb)] flex items-center justify-center px-4">
      <div className="bg-[color:var(--surface-fff)] rounded-xl shadow-md p-8 w-full max-w-sm">
        <h1 className="text-2xl font-bold text-center text-[color:var(--ink-4338ca)] mb-2">公论</h1>
        <p className="text-center text-[color:var(--ink-6b7280)] text-sm mb-6">创建您的与会者账户，参与公论</p>
        {error && (
          <div className="bg-[color:var(--surface-fef2f2)] border border-[color:var(--line-fecaca)] text-[color:var(--ink-dc2626)] rounded px-3 py-2 text-sm mb-4">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-[color:var(--ink-374151)] mb-1">与会者名</label>
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="2-30位字母、数字、下划线或汉字"
              className="w-full border border-[color:var(--line-d1d5db)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--fragment-accent)]"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-[color:var(--ink-374151)] mb-1">密码</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="请输入密码"
              className="w-full border border-[color:var(--line-d1d5db)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--fragment-accent)]"
            />
          </div>
          {founderKeyRequired && <div>
            <label htmlFor="founder-key" className="block text-sm font-medium text-[color:var(--ink-374151)] mb-1">初始发起人密钥</label>
            <input id="founder-key" type="password" autoComplete="off" value={founderKey}
              onChange={e => setFounderKey(e.target.value)}
              placeholder="站点首次初始化时需要"
              className="w-full border border-[color:var(--line-d1d5db)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[color:var(--fragment-accent)]" />
          </div>}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-[color:var(--surface-4f46e5)] hover:bg-[color:var(--surface-4338ca)] disabled:bg-[color:var(--surface-a5b4fc)] text-[color:var(--ink-fff-2)] py-2 rounded-lg text-sm font-semibold transition-colors"
          >
            {loading ? '注册中…' : '注册账户'}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-[color:var(--ink-6b7280)]">
          已有账户？{' '}
          <Link to="/login" className="text-[color:var(--ink-4f46e5-2)] hover:underline font-medium">
            立即登录
          </Link>
        </p>
      </div>
    </div>
  );
}
