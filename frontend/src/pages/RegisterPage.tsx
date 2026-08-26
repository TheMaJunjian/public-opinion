import { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { storePrivateKeyForUser } from '../api/client';
import { generateSigningKeyPair } from '../utils/signature';

export default function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const appRoot = document.querySelector<HTMLElement>('#root > div');
    const previousBackground = appRoot?.style.backgroundColor ?? '';
    if (appRoot) appRoot.style.backgroundColor = '#fff';
    return () => {
      if (appRoot) appRoot.style.backgroundColor = previousBackground;
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const normalizedUsername = username.trim();
    if (!normalizedUsername || !password) { setError('请填写与会者名和密码'); return; }
    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]{2,30}$/.test(normalizedUsername)) {
      setError('与会者名需为 2-30 位字母、数字、下划线或汉字（不含空格和标点）');
      return;
    }
    if (password.length > 100) { setError('密码最多100位'); return; }
    setError('');
    setLoading(true);
    try {
      const keyPair = await generateSigningKeyPair();
      const jwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
      storePrivateKeyForUser(normalizedUsername, jwk);
      const pubJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
      const publicKey = JSON.stringify(pubJwk);

      await register(normalizedUsername, password, publicKey);
      localStorage.setItem('registration-guide-pending', 'true');
      navigate('/');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '注册失败，请重试');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-screen h-[calc(100dvh-4.25rem)] min-h-[calc(100dvh-4.25rem)] bg-white flex items-center justify-center px-4">
      <div className="bg-white rounded-xl shadow-md p-8 w-full max-w-sm">
        <h1 className="text-2xl font-bold text-center text-indigo-700 mb-2">公论</h1>
        <p className="text-center text-gray-500 text-sm mb-6">创建与会者账户，加入公论</p>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-600 rounded px-3 py-2 text-sm mb-4">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">与会者名</label>
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="2-30位字母、数字、下划线或汉字"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">密码</label>
            <input
              type="password"
              maxLength={100}
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="请输入密码（最多100位）"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white py-2 rounded-lg text-sm font-semibold transition-colors"
          >
            {loading ? '注册中…' : '注册账户'}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-gray-500">
          已有账户？{' '}
          <Link to="/login" className="text-indigo-600 hover:underline font-medium">
            立即登录
          </Link>
        </p>
      </div>
    </div>
  );
}
