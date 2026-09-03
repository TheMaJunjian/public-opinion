import { Link, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { Z_INDEX } from '../constants/zIndex';
import PointsBadge from './PointsBadge';

interface NavbarProps {
  onOpenViewer?: () => void;
  onOpenTutorial?: () => void;
  onOpenGuide?: () => void;
  guideEnabled?: boolean;
  topControlsFrozen?: boolean;
  onToggleTopControls?: () => void;
  onHeightChange?: (height: number) => void;
}

/** 顶部导航栏：展示系统名称"公论"与登录/注销入口 */
export default function Navbar({ onOpenViewer, onOpenTutorial, onOpenGuide, guideEnabled = false, topControlsFrozen = false, onToggleTopControls, onHeightChange }: NavbarProps) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const navRef = useRef<HTMLElement>(null);
  const leftControlsRef = useRef<HTMLDivElement>(null);
  const rightControlsRef = useRef<HTMLDivElement>(null);
  const [rightControlsPinned, setRightControlsPinned] = useState(true);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;

    const updatePinnedState = () => {
      const leftControls = leftControlsRef.current;
      const rightControls = rightControlsRef.current;
      if (!leftControls || !rightControls) return;

      const navRect = nav.getBoundingClientRect();
      onHeightChange?.(navRect.height);
      const leftRect = leftControls.getBoundingClientRect();
      const rightRect = rightControls.getBoundingClientRect();
      const normalRight = navRect.left + rightControls.offsetLeft + rightRect.width;
      const pinnedLeft = Math.min(normalRight, window.innerWidth) - rightRect.width;
      setRightControlsPinned(leftRect.right + 16 <= pinnedLeft);
    };

    updatePinnedState();
    const observer = new ResizeObserver(updatePinnedState);
    observer.observe(nav);
    window.addEventListener('resize', updatePinnedState);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updatePinnedState);
    };
  }, [onHeightChange]);

  async function handleLogout() {
    try {
      await logout();
    } finally {
      navigate('/login', { replace: true });
    }
  }

  return (
    <nav ref={navRef} className="relative bg-indigo-700 text-white px-6 py-3 flex items-center shadow-md" style={topControlsFrozen ? { position: 'sticky', top: 0, zIndex: Z_INDEX.freezeButton } : undefined}>
      <div ref={leftControlsRef} className="relative flex shrink-0 items-center gap-4">
        <Link to="/" className="flex flex-col leading-tight hover:opacity-90 transition-opacity">
          <span className="text-xl font-bold tracking-widest">公论</span>
          <span className="text-xs text-indigo-300 tracking-wide">一切记录在案，是非自有公论</span>
        </Link>
        <button
          type="button"
          data-guide-button="true"
          onClick={guideEnabled ? onOpenGuide : undefined}
          disabled={!guideEnabled}
          aria-disabled={!guideEnabled}
          className={`ml-8 text-sm font-medium transition-colors ${guideEnabled ? 'text-amber-200 hover:text-white' : 'cursor-not-allowed text-indigo-300/50'}`}
          title="开始入门引导"
        >
          引导
        </button>
        <button
          onClick={onOpenTutorial}
          className="text-indigo-200 hover:text-white text-sm font-medium transition-colors"
          title="打开教程"
        >
          教程
        </button>
        <button
          type="button"
          onClick={onToggleTopControls}
          aria-label={topControlsFrozen ? '解冻顶部控件' : '冻结顶部控件'}
          aria-pressed={topControlsFrozen}
          title={topControlsFrozen ? '解冻教程、退出和关系类型控件' : '冻结教程、退出和关系类型控件'}
          className="absolute left-[calc(100%+8px)] top-full flex h-6 w-6 items-center justify-center rounded-full text-xs shadow-md"
          style={{
            background: 'transparent',
            color: 'rgba(255,255,255,0.7)',
            zIndex: Z_INDEX.freezeButton,
          }}
        >
          {topControlsFrozen ? (
            <span aria-hidden="true" className="relative inline-block h-4 w-4 translate-y-0.5 rounded-full border-2 border-red-500">
              <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-red-500" />
            </span>
          ) : '📌'}
        </button>
      </div>
      <div aria-hidden="true" className="flex-1 min-w-4" />
      <div ref={rightControlsRef} className={`${rightControlsPinned ? 'sticky right-0' : ''} flex shrink-0 items-center gap-4 bg-indigo-700 pl-2 pr-4`} style={{ zIndex: Z_INDEX.popup }}>
        {user ? (
          <>
            <button
              onClick={onOpenViewer}
              className="text-indigo-200 hover:text-white text-sm font-medium transition-colors"
              title="阅览导出的消息文本"
            >
              阅览
            </button>
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
            <button
              onClick={onOpenViewer}
              className="text-indigo-200 hover:text-white text-sm font-medium transition-colors"
              title="阅览导出的消息文本"
            >
              阅览
            </button>
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
