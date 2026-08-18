import { BrowserRouter, HashRouter, Routes, Route } from 'react-router-dom';
import { Suspense, lazy, useState } from 'react';
import { AuthProvider } from './context/AuthContext';
import Navbar from './components/Navbar';
import GestureShortcutManager from './components/GestureShortcutManager';
import { GestureDirection, ShortcutSymbol } from './utils/gestureShortcut';

const LoginPage = lazy(() => import('./pages/LoginPage'));
const RegisterPage = lazy(() => import('./pages/RegisterPage'));
const HomePage = lazy(() => import('./pages/HomePage'));
const TopicDetailPage = lazy(() => import('./pages/TopicDetailPage'));
const ExportViewerModal = lazy(() => import('./components/ExportViewerModal'));
const TutorialModal = lazy(() => import('./components/TutorialModal'));

export default function App() {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [interfaceZoom, setInterfaceZoom] = useState(1);
  const Router = window.location.protocol === 'file:' || import.meta.env.PROD ? HashRouter : BrowserRouter;
  const handleGestureConfirm = (direction: GestureDirection, target: HTMLElement | null, symbol: ShortcutSymbol) => {
    if (symbol === 'zoom-in' || symbol === 'zoom-out') {
      setInterfaceZoom(currentZoom => {
        const nextZoom = symbol === 'zoom-in'
          ? Math.min(1.5, currentZoom + 0.1)
          : Math.max(0.7, currentZoom - 0.1);
        return Number(nextZoom.toFixed(2));
      });
      return;
    }
    if (symbol === 'confirm') {
      const confirmTarget = document.querySelector<HTMLElement>('[data-shortcut-confirm="true"]');
      if (confirmTarget) confirmTarget.click();
      else document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return;
    }
    if (symbol === 'cancel') {
      const cancelTarget = document.querySelector<HTMLElement>('[data-shortcut-cancel="true"]');
      if (cancelTarget) cancelTarget.click();
      else document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return;
    }
    if (!target) return;
    const amount = direction === 'up' || direction === 'down'
      ? target.clientHeight * 0.7
      : target.clientWidth * 0.7;
    const top = direction === 'up' ? -amount : direction === 'down' ? amount : 0;
    const left = direction === 'left' ? -amount : direction === 'right' ? amount : 0;
    if (target === document.documentElement || target === document.body) {
      window.scrollBy({ top, left, behavior: 'smooth' });
    } else {
      target.scrollBy({ top, left, behavior: 'smooth' });
    }
  };
  const routeFallback = (
    <div className="flex h-full items-center justify-center text-sm text-gray-500">
      加载中…
    </div>
  );

  return (
    <AuthProvider>
      <Router>
        <div
          className="h-screen min-w-fit flex flex-col bg-[#101010]"
          style={{
            transform: `scale(${interfaceZoom})`,
            transformOrigin: 'top left',
            width: `${100 / interfaceZoom}%`,
            minHeight: `${100 / interfaceZoom}vh`,
          }}
        >
          <GestureShortcutManager onConfirm={handleGestureConfirm} />
          <Navbar
            onOpenViewer={() => setViewerOpen(true)}
            onOpenTutorial={() => setTutorialOpen(true)}
          />
          <main className="flex-1">
            <Suspense fallback={routeFallback}>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />
                <Route path="/" element={<HomePage />} />
                <Route path="/topics/:topicId" element={<TopicDetailPage />} />
              </Routes>
            </Suspense>
          </main>
          {viewerOpen && (
            <Suspense fallback={null}>
              <ExportViewerModal
                key="open"
                open={viewerOpen}
                onClose={() => setViewerOpen(false)}
              />
            </Suspense>
          )}
          {tutorialOpen && (
            <Suspense fallback={null}>
              <TutorialModal
                open={tutorialOpen}
                onClose={() => setTutorialOpen(false)}
              />
            </Suspense>
          )}
        </div>
      </Router>
    </AuthProvider>
  );
}
