import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';

/**
 * 首页：登录后自动跳转到第一个分类的详情页。
 * 若当前无分类，则自动创建一个默认分类后跳转。
 * 未登录时跳转到登录页。
 */
export default function HomePage() {
  const { user, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    if (authLoading) return;
    if (!user) {
      if (!cancelled) navigate('/login', { replace: true });
      return () => { cancelled = true; };
    }

    async function loadOrCreate() {
      try {
        const res = await api.getTopics({ limit: 1 });
        if (cancelled) return;
        if (res.data.length > 0) {
          navigate(`/topics/${res.data[0].id}`, { replace: true });
        } else {
          let topic;
          try {
            topic = await api.createTopic({ title: '公论' });
          } catch (createErr: unknown) {
            if (cancelled) return;
            setError(`创建默认空间失败：${createErr instanceof Error ? createErr.message : createErr}`);
            return;
          }
          if (cancelled) return;
          navigate(`/topics/${topic.id}`, { replace: true });
        }
      } catch (e: unknown) {
        if (cancelled) return;
        setError(`加载分类失败：${e instanceof Error ? e.message : e}`);
      }
    }

    loadOrCreate();
    return () => { cancelled = true; };
  }, [user, authLoading, navigate]);

  if (error) {
    return (
      <div style={{ padding: 16, background: '#101010', color: '#eee', height: '100%' }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>加载失败</div>
        <pre style={{ whiteSpace: 'pre-wrap', color: '#ff8080' }}>{error}</pre>
      </div>
    );
  }

  return (
    <div style={{ padding: 16, background: '#101010', color: '#eee', height: '100%' }}>
      加载中…
    </div>
  );
}
