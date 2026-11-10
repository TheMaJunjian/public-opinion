import { lazy, Suspense, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { PageLoadingPrompt } from './WorkbenchStartup';
import { AutoAuthEntryContext } from '../context/AutoAuthEntryContext';
import PromptModal from './PromptModal';
import { ABOUT_HOME_STATE_KEY } from '../utils/aboutNavigation';

const LoginPage = lazy(() => import('../pages/LoginPage'));
const RegisterPage = lazy(() => import('../pages/RegisterPage'));

function hasExistingDialog() {
  return Array.from(document.querySelectorAll<HTMLElement>('[aria-modal="true"], [data-popup-overlay="true"], [data-guide-overlay="true"]'))
    .some(element => {
      if (element.closest('[data-auth-entry-modal="true"], [hidden], [aria-hidden="true"], [inert]')) return false;
      for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
        const style = window.getComputedStyle(ancestor);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
      }
      return true;
    });
}

function useExistingDialog(active: boolean) {
  const [suspended, setSuspended] = useState(hasExistingDialog);
  useLayoutEffect(() => {
    if (!active) return;
    const update = () => setSuspended(hasExistingDialog());
    // Sibling portals may have mounted in this commit after the gate rendered.
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ['aria-modal', 'aria-hidden', 'hidden', 'inert', 'style', 'data-popup-overlay', 'data-guide-overlay'],
    });
    return () => observer.disconnect();
  }, [active]);
  return suspended;
}

/** Ask once on entry, preserving the visited address until the visitor signs in or dismisses the dialog. */
export default function AuthEntryGate({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [dismissed, setDismissed] = useState(false);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const authRoute = pathname === '/login' || pathname === '/register';
  const localViewer = pathname === '/viewer' || window.location.protocol === 'file:';
  const needsEntry = !authRoute && !localViewer && !user && !dismissed;
  const suspended = useExistingDialog(needsEntry);
  useEffect(() => { if (user || authRoute) setDismissed(true); }, [user, authRoute]);
  if (authRoute || localViewer || user || dismissed) return children;
  const close = () => setDismissed(true);
  return <AutoAuthEntryContext.Provider value={{ suspended }}><Suspense fallback={<PageLoadingPrompt />}>
    {loading ? <PromptModal open title="正在加载" message="正在确认登录状态，也可直接离线使用本地消息文件。"
      confirmText="离线使用本地消息文件" onConfirm={() => {
        close(); navigate('/', { state: { [ABOUT_HOME_STATE_KEY]: true } });
        window.dispatchEvent(new Event('open-export-viewer'));
      }} /> : mode === 'login'
      ? <LoginPage onClose={close} onSuccess={close} onRegister={() => setMode('register')} closeText="关闭并浏览" />
      : <RegisterPage onClose={close} onSuccess={close} onLogin={() => setMode('login')} closeText="关闭并浏览" />}
  </Suspense></AutoAuthEntryContext.Provider>;
}
