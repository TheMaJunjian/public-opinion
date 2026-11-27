import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { clearCloudMeetingStorage, closeLegacyInlineViewer, cloudLogoutStamp, CLOUD_LOGOUT_KEY, CLOUD_LOGOUT_REQUEST, legacyLogoutTarget, rememberLegacyInlineViewer, tabCloudMeetingId, useCloudViewer, type LegacyLogoutTarget } from '../utils/cloudMeetingAccount';
import { clearPendingWpsDocument } from '../utils/wpsAccessReturn';
import { signOutGitHubHostedAuth } from '../utils/githubHostedAuth';
import PromptModal from './PromptModal';

export default function CloudMeetingLogout({ closeViewers }: { closeViewers: (resetActive: boolean) => void }) {
  const navigate = useNavigate(), location = useLocation();
  const { user, logout } = useAuth();
  const [stage, setStage] = useState<'confirm' | 'working' | 'done' | 'error' | null>(null);
  const [includeGonglun, setIncludeGonglun] = useState(false);
  const [visitWps, setVisitWps] = useState(false);
  const [error, setError] = useState('');
  const busy = useRef(false), observed = useRef(cloudLogoutStamp());
  const pendingLegacy = useRef<LegacyLogoutTarget>();
  const latestLocation = useRef(location);
  latestLocation.current = location;
  const routeId = location.state?.viewerCacheRef?.archiveId;
  const openId = location.pathname === '/viewer' ? routeId ?? tabCloudMeetingId() : undefined;
  const cloudSource = useCloudViewer(location.state);
  const active = location.pathname === '/viewer' && cloudSource;
  useLayoutEffect(() => {
    if (active) rememberLegacyInlineViewer(location.state, location.state?.viewerInstanceKey ?? location.key);
  }, [active, location.state, location.key]);

  const leaveViews = useCallback(() => {
    if (active) closeLegacyInlineViewer(location.state, location.state?.viewerInstanceKey ?? location.key);
    flushSync(() => {
      closeViewers(active);
      if (active) navigate('/', { replace: true, state: null });
    });
    clearPendingWpsDocument();
  }, [active, closeViewers, navigate, location.state, location.key]);

  const finishLegacyCleanup = useCallback((verifiedId?: string) => {
    // A logout can arrive while the old viewer is still loading its cache,
    // before its WPS hook has registered the ordinary archive ID.
    const current = latestLocation.current;
    if (verifiedId && !active && current.pathname === '/viewer' && current.key === location.key
      && current.state?.viewerCacheRef?.archiveId === verifiedId) {
      flushSync(() => { closeViewers(true); navigate('/', { replace: true, state: null }); });
    }
    clearCloudMeetingStorage(verifiedId);
  }, [active, location.key, closeViewers, navigate]);

  useEffect(() => {
    const request = (event: Event) => {
      if (busy.current) return;
      setIncludeGonglun(Boolean((event as CustomEvent).detail?.includeGonglun));
      const id = openId ?? tabCloudMeetingId();
      setVisitWps(id?.startsWith('wps-document:') === true || (active && !id?.startsWith('git-issue:'))
        || (!!id && id === tabCloudMeetingId() && legacyLogoutTarget(location.state)?.archiveId === id));
      setStage('confirm');
    };
    const receive = async () => {
      const stamp = cloudLogoutStamp();
      if (!stamp || stamp === observed.current) return;
      observed.current = stamp;
      const legacy = legacyLogoutTarget(location.state);
      pendingLegacy.current = legacy;
      leaveViews();
      try {
        const [{ clearGitMeetingTokens }, { forgetCloudMeetingMemory, forgetLegacyWpsArchive }] = await Promise.all([
          import('../utils/gitMeetingSession'), import('../utils/exportViewerCache'),
        ]);
        clearGitMeetingTokens();
        forgetCloudMeetingMemory(legacy);
        const [verifiedId] = await Promise.all([forgetLegacyWpsArchive(legacy), signOutGitHubHostedAuth()]);
        finishLegacyCleanup(verifiedId);
        pendingLegacy.current = undefined;
        setStage(null);
      } catch { setError('本标签页未能清除云端讨论的登录状态，请重试。'); setStage('error'); }
    };
    const storage = (event: StorageEvent) => { if (event.key === CLOUD_LOGOUT_KEY) void receive(); };
    window.addEventListener(CLOUD_LOGOUT_REQUEST, request);
    window.addEventListener('storage', storage);
    window.addEventListener('pageshow', receive);
    return () => {
      window.removeEventListener(CLOUD_LOGOUT_REQUEST, request);
      window.removeEventListener('storage', storage);
      window.removeEventListener('pageshow', receive);
    };
  }, [active, openId, location.state, leaveViews, finishLegacyCleanup]);

  async function signOut() {
    if (busy.current) return;
    busy.current = true;
    setStage('working');
    try {
      const legacy = pendingLegacy.current ?? legacyLogoutTarget(location.state);
      pendingLegacy.current = legacy;
      leaveViews();
      const [{ clearGitMeetingTokens }, { forgetCloudMeetingArchives, forgetCloudMeetingMemory, forgetLegacyWpsArchive }] = await Promise.all([
        import('../utils/gitMeetingSession'), import('../utils/exportViewerCache'),
      ]);
      clearGitMeetingTokens();
      forgetCloudMeetingMemory(legacy);
      const stamp = crypto.randomUUID();
      observed.current = stamp;
      const results = await Promise.allSettled([
        Promise.resolve().then(() => localStorage.setItem(CLOUD_LOGOUT_KEY, stamp)),
        forgetLegacyWpsArchive(legacy).then(finishLegacyCleanup),
        forgetCloudMeetingArchives(),
        signOutGitHubHostedAuth(),
        includeGonglun && user ? logout() : Promise.resolve(),
      ]);
      const failed = results.find(result => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
      pendingLegacy.current = undefined;
      if (visitWps) window.location.assign('https://account.wps.cn/usercenter/');
      setStage('done');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '清除登录状态失败，请重试。');
      setStage('error');
    } finally { busy.current = false; }
  }

  if (!stage) return null;
  if (stage === 'done') return <PromptModal open title="已退出云端讨论" confirmText="完成"
    onConfirm={() => setStage(null)} message={<>
      本机已停止同步，已清除云端讨论缓存和 GitHub 令牌。
      {' '}<a href="https://account.wps.cn/usercenter/">前往 WPS 账号中心退出或切换账号</a>
    </>} />;
  return <PromptModal open title={includeGonglun ? '退出登录并清除云端讨论' : '退出云端讨论'}
    confirmText={stage === 'working' ? '正在清除…' : stage === 'error' ? '重新清除' : '退出并清除'}
    confirmDisabled={stage === 'working'} onConfirm={() => void signOut()}
    onCancel={stage === 'working' ? undefined : () => setStage(null)}
    message={<div style={{ display: 'grid', gap: 10 }}>
      <p>清除本浏览器中 WPS 和 Git 讨论的缓存、发言人及 GitHub 令牌，并停止其他公论标签页中的云端讨论同步。云端原件由提供方保存。</p>
      <label><input type="checkbox" checked={visitWps} disabled={stage === 'working'}
        onChange={event => setVisitWps(event.target.checked)} /> 同时前往 WPS 账号中心</label>
      <small>要退出 WPS 的网页登录，请在账号中心顶部选择「退出账号」。</small>
      {stage === 'error' && <span role="alert">{error}</span>}
    </div>} />;
}
