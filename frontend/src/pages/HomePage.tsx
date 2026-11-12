import { lazy, Suspense, useEffect } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { PageLoadingPrompt } from '../components/WorkbenchStartup';
import AboutLink from '../components/AboutLink';
import { ABOUT_HOME_STATE_KEY } from '../utils/aboutNavigation';
const FeedPage = lazy(() => import('./FeedPage'));

/** Online participation and local message files have independent entry points. */
export default function HomePage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const explicitHome = location.state?.[ABOUT_HOME_STATE_KEY] === true;
  const messageLink = location.pathname === '/' && new URLSearchParams(location.search).has('msg');
  const returnTo = messageLink ? `/messages${location.search}` : `${location.pathname}${location.search}`;
  useEffect(() => {
    if (!loading && user && !explicitHome && messageLink) navigate(`/messages${location.search}`, { replace: true });
  }, [user, loading, navigate, explicitHome, messageLink, location.search]);
  if (user && !explicitHome && messageLink) return <PageLoadingPrompt />;
  if (user && !explicitHome) return <Suspense fallback={<p role="status">正在打开讨论首页…</p>}><FeedPage key={user.id} /></Suspense>;
  return <section aria-label="公论" className="home-page" style={{ width: '100%', maxWidth: 680, boxSizing: 'border-box', margin: '64px auto', padding: 32, color: 'var(--text-primary)' }}>
    <div className="home-background-motto" aria-hidden="true">
      {['大道唯争', '百无禁忌'].map(motto => <svg key={motto} viewBox="0 0 100 400" focusable="false">
        {[...motto].map((character, index) => <text key={character} x="50" y={88 + index * 100} textLength="96" lengthAdjust="spacingAndGlyphs">{character}</text>)}
      </svg>)}
    </div>
    <h1 style={{ fontSize: 30, fontWeight: 700, marginBottom: 12 }}>公论</h1>
    <p style={{ fontSize: 18, lineHeight: 1.8, marginBottom: 12 }}>一切记录在案，是非自有公论</p>
    <p style={{ lineHeight: 1.8, color: 'var(--text-secondary)' }}>公论是讨论、投票和线上文字开会的工具。</p>
    <p style={{ lineHeight: 1.8, marginTop: 12 }}>公论中有：发言投票（权），胜利的一方获得贡献点（钱），给所有人留下被认可的信息（真理）。</p>
    <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 20, marginTop: 24 }}>
      <Link to={user ? returnTo : '/login'} state={{ returnTo }} className="home-primary-action">{user ? '进入讨论首页' : '登录公论'}</Link>
      {!user && <Link to="/register" state={{ returnTo }} style={{ fontSize: 14, color: 'var(--ink-94a3b8)' }}>注册账号</Link>}
      <button type="button" onClick={() => window.dispatchEvent(new Event('open-export-viewer'))}
        className="home-primary-action">离线使用</button>
      <AboutLink style={{ fontSize: 14, color: 'var(--ink-94a3b8)' }}>了解公论</AboutLink>
    </div>
    <div style={{ marginTop: 36, fontSize: 12, color: 'var(--ink-64748b)' }}>
      <button type="button" onClick={() => window.dispatchEvent(new Event('open-export-viewer'))}
        style={{ padding: 0, border: 0, background: 'none', color: 'var(--ink-94a3b8)', cursor: 'pointer', font: 'inherit', textDecoration: 'underline', textUnderlineOffset: 3 }}>阅览本机文件</button>
      <span style={{ marginLeft: 8 }}>无需邀请或登录；支持本地整理、保存和导出</span>
    </div>
  </section>;
}
