import { Link, useNavigate } from 'react-router-dom';
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { Z_INDEX } from '../constants/zIndex';
import ThemeSwitcher from '../theme/ThemeSwitcher';
import PointsBadge from './PointsBadge';
import { useInterfaceZoom } from '../context/InterfaceZoomContext';

interface NavbarProps {
  onOpenViewer?: () => void;
  onOpenTutorial?: () => void;
  onOpenWelfare?: () => void;
  onOpenGuide?: () => void;
  guideEnabled?: boolean;
}

/** 顶部导航栏：展示系统名称"公论"与登录/注销入口 */
export default function Navbar({ onOpenViewer, onOpenTutorial, onOpenWelfare, onOpenGuide, guideEnabled = false }: NavbarProps) {
  const interfaceZoom = useInterfaceZoom();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const navRef = useRef<HTMLElement>(null);
  const leftControlsRef = useRef<HTMLDivElement>(null);
  const rightControlsRef = useRef<HTMLDivElement>(null);
  const [rightControlsRightOffset, setRightControlsRightOffset] = useState(16);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;

    const updateLayout = () => {
      const leftControls = leftControlsRef.current;
      const rightControls = rightControlsRef.current;
      if (!leftControls || !rightControls) return;

      const leftRect = leftControls.getBoundingClientRect();
      const rightRect = rightControls.getBoundingClientRect();
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      // Preserve the navbar's outer padding even when the workbench is wider
      // than the viewport. CSS sticky accounts for the native scrollbar.
      const nextRightOffset = Math.min(16, (viewportWidth - leftRect.right - rightRect.width) / interfaceZoom - 16);
      setRightControlsRightOffset(current => current === nextRightOffset ? current : nextRightOffset);
    };

    updateLayout();
    const observer = new ResizeObserver(updateLayout);
    observer.observe(nav);
    observer.observe(document.documentElement);
    window.addEventListener('resize', updateLayout);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateLayout);
    };
  }, [interfaceZoom]);

  async function handleLogout() {
    try {
      await logout();
    } finally {
      navigate('/login', { replace: true });
    }
  }

  return (
    <nav ref={navRef} className="app-navbar relative bg-[color:var(--surface-4338ca)] text-[color:var(--ink-fff-2)] pl-6 pr-4 py-3 flex items-center shadow-md">
      <div ref={leftControlsRef} className="app-navbar-primary relative flex shrink-0 items-center gap-4">
        <Link to="/" className="flex flex-col leading-tight hover:opacity-90 transition-opacity">
          <span className="text-xl font-bold tracking-widest">公论</span>
          <span className="text-xs text-[color:var(--ink-a5b4fc-3)] tracking-wide">一切记录在案，是非自有公论</span>
        </Link>
        <button
          type="button"
          data-guide-button="true"
          onClick={guideEnabled ? onOpenGuide : undefined}
          disabled={!guideEnabled}
          aria-disabled={!guideEnabled}
          className={`ml-8 text-sm font-medium transition-colors ${guideEnabled ? 'text-[color:var(--ink-fde68a-2)] hover:text-[color:var(--ink-fff-2)]' : 'cursor-not-allowed text-[color:color-mix(in_srgb,var(--ink-a5b4fc-3)_50%,transparent)]'}`}
          title="开始入门引导"
        >
          引导
        </button>
        <button
          onClick={onOpenTutorial}
          className="text-[color:var(--ink-c7d2fe)] hover:text-[color:var(--ink-fff-2)] text-sm font-medium transition-colors"
          title="打开教程"
        >
          教程
        </button>
        <button
          type="button"
          onClick={onOpenWelfare}
          className="text-[color:var(--ink-c7d2fe)] hover:text-[color:var(--ink-fff-2)] text-sm font-medium transition-colors"
          title="打开福利"
        >
          福利
        </button>
      </div>
      <div aria-hidden="true" className="min-w-0 flex-1" />
      <div ref={rightControlsRef} className="app-navbar-account sticky flex shrink-0 items-center gap-4 bg-[color:var(--surface-4338ca)] pl-2" style={{ right: `${rightControlsRightOffset}px`, zIndex: Z_INDEX.popup }}>
        <ThemeSwitcher />
        {user ? (
          <>
            <button
              onClick={onOpenViewer}
              className="text-[color:var(--ink-c7d2fe)] hover:text-[color:var(--ink-fff-2)] text-sm font-medium transition-colors"
              title="阅览导出的消息文本"
            >
              阅览
            </button>
            <PointsBadge />
            <span className="text-[color:var(--ink-c7d2fe)] text-sm">
              {user.username}
            </span>
            <button
              onClick={handleLogout}
              className="bg-[color:var(--surface-6366f1)] hover:bg-[color:var(--surface-818cf8)] px-4 py-1.5 rounded text-sm font-medium transition-colors"
            >
              退出登录
            </button>
          </>
        ) : (
          <>
            <button
              onClick={onOpenViewer}
              className="text-[color:var(--ink-c7d2fe)] hover:text-[color:var(--ink-fff-2)] text-sm font-medium transition-colors"
              title="阅览导出的消息文本"
            >
              阅览
            </button>
            <Link to="/login" className="hover:text-[color:var(--ink-c7d2fe)] text-sm font-medium transition-colors">
              登录
            </Link>
            <Link
              to="/register"
              className="bg-[color:var(--surface-6366f1)] hover:bg-[color:var(--surface-818cf8)] px-4 py-1.5 rounded text-sm font-medium transition-colors"
            >
              注册
            </Link>
          </>
        )}
      </div>
    </nav>
  );
}
