import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { PageLoadingPrompt } from '../components/WorkbenchStartup';

/** The public workbench is a view, only a message query. */
export default function HomePage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  useEffect(() => {
    if (!loading) navigate(user ? '/messages' : '/login', { replace: true });
  }, [user, loading, navigate]);
  return <PageLoadingPrompt />;
}
