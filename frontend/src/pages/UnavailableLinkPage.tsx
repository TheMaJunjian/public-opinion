import { useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import PromptModal from '../components/PromptModal';
import { dialogStyles } from '../components/dialogStyles';

export default function UnavailableLinkPage({ legacyTopic = false }: { legacyTopic?: boolean }) {
  const navigate = useNavigate();
  const goHome = useCallback(() => navigate('/', { replace: true }), [navigate]);
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => { if (event.key === 'Escape') goHome(); };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [goHome]);
  return <PromptModal open title={legacyTopic ? '旧话题链接已作废' : '链接无法打开'} hideActions
    message={<div style={{ whiteSpace: 'normal' }}>
      <p>{legacyTopic
        ? '这是旧版话题页面的地址，该页面已停止使用。可以刷新页面检查更新，或返回首页继续浏览公论。'
        : '该地址不存在或已经失效。可以刷新页面检查更新，或返回首页继续浏览公论。'}</p>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 20 }}>
        <button type="button" style={dialogStyles.button} onClick={() => window.location.reload()}>刷新页面</button>
        <button type="button" style={dialogStyles.primaryButton} data-shortcut-confirm="true" onClick={goHome}>回首页</button>
      </div>
    </div>}
    onConfirm={goHome} onCancel={goHome} onClose={goHome} />;
}
