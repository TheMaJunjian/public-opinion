import { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const redirectReason = (location.state as any)?.reason as string | undefined;
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim() || !password) { setError('请填写与会者名和密码'); return; }
    setError('');
    setLoading(true);
    try {
      await login(username.trim(), password);
      navigate('/');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '登录失败，请重试');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-[calc(100dvh-4.25rem)] bg-gray-50 flex items-center justify-center px-4">
      <div className="bg-white rounded-xl shadow-md p-8 w-full max-w-sm">
        <h1 className="text-2xl font-bold text-center text-indigo-700 mb-2">公论</h1>
        <p className="text-center text-gray-500 text-sm mb-6">登录您的与会者账户，参与公论</p>
        {redirectReason && (
          <div className="bg-amber-50 border border-amber-200 text-amber-700 rounded px-3 py-2 text-sm mb-4">
            ⚠️ {redirectReason}
          </div>
        )}
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
              placeholder="请输入与会者名"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">密码</label>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="请输入密码"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-400"
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white py-2 rounded-lg text-sm font-semibold transition-colors"
          >
            {loading ? '登录中…' : '登录'}
          </button>
        </form>
        <p className="mt-4 text-center text-sm text-gray-500">
          还没有账户？{' '}
          <Link to="/register" className="text-indigo-600 hover:underline font-medium">
            立即注册
          </Link>
        </p>
      </div>
    </div>
  );
}
