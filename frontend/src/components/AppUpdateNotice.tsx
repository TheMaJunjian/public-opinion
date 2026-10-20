import { useEffect, useState } from 'react';
import PromptModal from './PromptModal';

const currentBuildId = typeof __APP_BUILD_ID__ === 'string' ? __APP_BUILD_ID__ : '';

export default function AppUpdateNotice({ buildId = currentBuildId, enabled = import.meta.env.PROD,
  onRefresh = () => window.location.reload() }: { buildId?: string; enabled?: boolean; onRefresh?: () => void }) {
  const [available, setAvailable] = useState<string | null>(null);
  const [deferred, setDeferred] = useState<string | null>(null);
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
          && typeof version.id === 'string' && version.id && version.id !== buildId) setAvailable(version.id);
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
  return <PromptModal open={!!available && available !== deferred} title="版本更新"
    message="发现新版本，刷新后即可使用新功能。请先保存正在编辑的内容。"
    confirmText="立即刷新" cancelText="稍后处理" onConfirm={onRefresh} onCancel={() => setDeferred(available)} />;
}
