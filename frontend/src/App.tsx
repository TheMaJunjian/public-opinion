import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import Navbar from './components/Navbar';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import TopicListPage from './pages/TopicListPage';
import TopicDetailPage from './pages/TopicDetailPage';
import MessageDetailPage from './pages/MessageDetailPage';

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <div className="min-h-screen bg-gray-50">
          <Navbar />
          <main>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
              <Route path="/" element={<TopicListPage />} />
              <Route path="/topics/:topicId" element={<TopicDetailPage />} />
              <Route path="/topics/:topicId/messages/:messageId" element={<MessageDetailPage />} />
            </Routes>
          </main>
        </div>
      </BrowserRouter>
    </AuthProvider>
  );
}
