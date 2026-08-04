import { BrowserRouter, HashRouter, Routes, Route } from 'react-router-dom';
import { Suspense, lazy, useState } from 'react';
import { AuthProvider } from './context/AuthContext';
import Navbar from './components/Navbar';

const LoginPage = lazy(() => import('./pages/LoginPage'));
const RegisterPage = lazy(() => import('./pages/RegisterPage'));
const HomePage = lazy(() => import('./pages/HomePage'));
const TopicDetailPage = lazy(() => import('./pages/TopicDetailPage'));
const ExportViewerModal = lazy(() => import('./components/ExportViewerModal'));

export default function App() {
  const [viewerOpen, setViewerOpen] = useState(false);
  const Router = window.location.protocol === 'file:' || import.meta.env.PROD ? HashRouter : BrowserRouter;
  const routeFallback = (
    <div className="flex h-full items-center justify-center text-sm text-gray-500">
      加载中…
    </div>
  );

  return (
    <AuthProvider>
      <Router>
        <div className="h-screen min-w-fit flex flex-col bg-[#101010]">
          <Navbar onOpenViewer={() => setViewerOpen(true)} />
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
        </div>
      </Router>
    </AuthProvider>
  );
}
