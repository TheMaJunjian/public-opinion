import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { useState } from 'react';
import { AuthProvider } from './context/AuthContext';
import Navbar from './components/Navbar';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import HomePage from './pages/HomePage';
import TopicDetailPage from './pages/TopicDetailPage';
import ExportViewerModal from './components/ExportViewerModal';
import UserPage from './pages/UserPage';

export default function App() {
  const [viewerOpen, setViewerOpen] = useState(false);

  return (
    <AuthProvider>
      <BrowserRouter>
        <div className="h-screen overflow-hidden flex flex-col bg-gray-50">
          <Navbar onOpenViewer={() => setViewerOpen(true)} />
          <main className="flex-1 min-h-0 overflow-auto">
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
              <Route path="/" element={<HomePage />} />
              <Route path="/topics/:topicId" element={<TopicDetailPage />} />
              <Route path="/users/:userId" element={<UserPage />} />
            </Routes>
          </main>
          <ExportViewerModal key={viewerOpen ? 'open' : 'closed'} open={viewerOpen} onClose={() => setViewerOpen(false)} />
        </div>
      </BrowserRouter>
    </AuthProvider>
  );
}
