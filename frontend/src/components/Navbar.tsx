import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  return (
    <nav className="bg-indigo-700 text-white px-6 py-3 flex items-center justify-between shadow-md">
      <Link to="/" className="text-2xl font-bold tracking-wide hover:text-indigo-200 transition-colors">
        公论
      </Link>
      <div className="flex items-center gap-4">
        {user ? (
          <>
            <span className="text-indigo-200 text-sm">欢迎，{user.username}</span>
            <button
              onClick={handleLogout}
              className="bg-indigo-500 hover:bg-indigo-400 px-4 py-1.5 rounded text-sm font-medium transition-colors"
            >
              退出登录
            </button>
          </>
        ) : (
          <>
            <Link to="/login" className="hover:text-indigo-200 text-sm font-medium transition-colors">
              登录
            </Link>
            <Link
              to="/register"
              className="bg-indigo-500 hover:bg-indigo-400 px-4 py-1.5 rounded text-sm font-medium transition-colors"
            >
              注册
            </Link>
          </>
        )}
      </div>
    </nav>
  );
}
