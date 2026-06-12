import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import PointsBadge from './PointsBadge';

/** 顶部导航栏：展示系统名称"公论"与登录/注销入口 */
export default function Navbar() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/login');
  }

  return (
    <nav className="bg-indigo-700 text-white px-6 py-3 flex items-center justify-between shadow-md">
      <Link to="/" className="flex flex-col leading-tight hover:opacity-90 transition-opacity">
        <span className="text-xl font-bold tracking-widest">公论</span>
        <span className="text-xs text-indigo-300 tracking-wide">一切记录在案，是非自有公论</span>
      </Link>
      <div className="flex items-center gap-4">
        {user ? (
          <>
            <PointsBadge />
            <span className="text-indigo-200 text-sm">
              {user.username}
            </span>
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
