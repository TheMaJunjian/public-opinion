import { useEffect, useState, useSyncExternalStore } from 'react';
import { authorizeGitHub, hasGitHubHostedAuth, prepareGitHubHostedAuth } from '../utils/githubHostedAuth';
import { getGitHubGrant, rememberGitHubGrant, subscribeGitCredentials, type GitHubAccess } from '../utils/gitMeetingSession';

/** Preload the popup SDK while the form is visible so the click retains browser user activation. */
export function useGitHubAuthorization(visible: boolean, access: GitHubAccess) {
  const enabled = hasGitHubHostedAuth();
  const grant = useSyncExternalStore(subscribeGitCredentials, getGitHubGrant);
  const token = grant && (grant.access === 'private' || grant.access === access) ? grant.token : '';
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled || !visible) return;
    let active = true;
    setError('');
    prepareGitHubHostedAuth().then(() => { if (active) setReady(true); }).catch(cause => {
      if (active) setError(cause instanceof Error ? cause.message : '无法加载 GitHub 授权。');
    });
    return () => { active = false; };
  }, [enabled, visible, attempt]);

  async function connect(signal: AbortSignal, renew = false) {
    signal.throwIfAborted();
    if (token && !renew) return token;
    const authorized = await authorizeGitHub(access);
    signal.throwIfAborted();
    rememberGitHubGrant(authorized, access);
    return authorized;
  }

  return { enabled, ready: ready || !!token, connected: !!token, error, retry: () => setAttempt(value => value + 1), connect };
}
