import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import Navbar from './components/Navbar';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import HomePage from './pages/HomePage';
import TopicDetailPage from './pages/TopicDetailPage';
export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <div className="h-screen overflow-hidden flex flex-col bg-gray-50">
          <Navbar />
          <main className="flex-1 min-h-0 overflow-auto">
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
              <Route path="/" element={<HomePage />} />
              <Route path="/topics/:topicId" element={<TopicDetailPage />} />
            </Routes>
          </main>
        </div>
      </BrowserRouter>
    </AuthProvider>
  );
}
