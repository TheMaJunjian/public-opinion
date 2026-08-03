import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { storePrivateKeyForUser } from '../api/client';
import { generateSigningKeyPair } from '../utils/signature';

export default function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const normalizedUsername = username.trim();
    if (!normalizedUsername || !password) { setError('请填写用户名和密码'); return; }
    if (password !== confirm) { setError('两次密码不一致'); return; }
    if (password.length < 6) { setError('密码长度至少6位'); return; }
    setError('');
    setLoading(true);
    try {
      const keyPair = await generateSigningKeyPair();
      const jwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
      storePrivateKeyForUser(normalizedUsername, jwk);
      const pubJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
      const publicKey = JSON.stringify(pubJwk);

      await register(normalizedUsername, password, publicKey);
      navigate('/');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '注册失败，请重试');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="bg-white rounded-xl shadow-md p-8 w-full max-w-sm">
        <h1 className="text-2xl font-bold text-center text-indigo-700 mb-2">公论</h1>
        <p className="text-center text-gray-500 text-sm mb-6">创建账户，加入公共讨论</p>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-600 rounded px-3 py-2 text-sm mb-4">
            {error}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">用户名</label>
            <input
              type="text"
              name="username"
              autoComplete="username"
              value={username}
              onChange={e => setUsername(e.target.value)}
              placeholder="请输入用户名"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">密码</label>
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="至少6位"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">确认密码</label>
            <input
              type="password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              placeholder="再次输入密码"
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
