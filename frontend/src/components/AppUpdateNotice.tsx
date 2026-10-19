import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

const currentBuildId = typeof __APP_BUILD_ID__ === 'string' ? __APP_BUILD_ID__ : '';

export default function AppUpdateNotice({ buildId = currentBuildId, enabled = import.meta.env.PROD,
  onRefresh = () => window.location.reload() }: { buildId?: string; enabled?: boolean; onRefresh?: () => void }) {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!enabled || !buildId || window.location.protocol === 'file:') return;
    let stopped = false;
    let pending: AbortController | null = null;
    async function check() {
      if (stopped || pending || document.visibilityState === 'hidden') return;
      const controller = new AbortController();
      pending = controller;
      const timeout = window.setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(new URL('build.json', document.baseURI), { cache: 'no-store', signal: controller.signal });
        if (!response.ok) return;
        const version: unknown = await response.json();
        if (!stopped && version && typeof version === 'object' && 'id' in version
          && typeof version.id === 'string' && version.id && version.id !== buildId) setAvailable(true);
      } catch { /* A failed or offline check does not imply that a new version exists. */ }
      finally { window.clearTimeout(timeout); if (pending === controller) pending = null; }
    }
    const checkNow = () => { void check(); };
    checkNow();
    const interval = window.setInterval(checkNow, 60000);
    window.addEventListener('focus', checkNow);
    window.addEventListener('pageshow', checkNow);
    document.addEventListener('visibilitychange', checkNow);
    window.addEventListener('vite:preloadError', checkNow);
    return () => {
      stopped = true; pending?.abort(); window.clearInterval(interval);
      window.removeEventListener('focus', checkNow);
      window.removeEventListener('pageshow', checkNow);
      document.removeEventListener('visibilitychange', checkNow);
      window.removeEventListener('vite:preloadError', checkNow);
    };
  }, [buildId, enabled]);
  if (!available) return null;
  return createPortal(<aside role="status" aria-label="版本更新" style={{ position: 'fixed', bottom: 16, right: 16,
    zIndex: 3101, width: 'min(380px, calc(100vw - 32px))', padding: 16, borderRadius: 10,
    border: '1px solid #4a9eff', background: '#1f2937', color: '#f3f4f6', boxShadow: '0 8px 32px #0008' }}>
    <div style={{ fontWeight: 600 }}>发现新版本</div>
    <p style={{ fontSize: 14, margin: '8px 0' }}>刷新后即可使用新功能。请先保存正在编辑的内容。</p>
    <button onClick={onRefresh} style={{ padding: '6px 14px', borderRadius: 6, border: 0, background: '#2563eb', color: '#fff', cursor: 'pointer' }}>立即刷新</button>
  </aside>, document.body);
}
