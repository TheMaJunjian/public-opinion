import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizeGitHub, hasGitHubHostedAuth, prepareGitHubHostedAuth, signOutGitHubHostedAuth } from '../utils/githubHostedAuth';

const sdk = vi.hoisted(() => {
  class Provider {
    static credentialFromResult = vi.fn();
    addScope = vi.fn();
  }
  const authStateReady = vi.fn(async () => {});
  return {
    Provider, authStateReady, initializeApp: vi.fn((_options: unknown, name: string) => ({ name })),
    initializeAuth: vi.fn((app: { name: string }) => ({ app, authStateReady })),
    deleteApp: vi.fn(async () => {}), signInWithPopup: vi.fn(), signOut: vi.fn(async () => {}),
    inMemoryPersistence: {}, browserPopupRedirectResolver: {},
  };
});
vi.mock('firebase/app', () => ({ initializeApp: sdk.initializeApp, deleteApp: sdk.deleteApp }));
vi.mock('firebase/auth', () => ({
  initializeAuth: sdk.initializeAuth, GithubAuthProvider: sdk.Provider, signInWithPopup: sdk.signInWithPopup,
  inMemoryPersistence: sdk.inMemoryPersistence, browserPopupRedirectResolver: sdk.browserPopupRedirectResolver, signOut: sdk.signOut,
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('VITE_FIREBASE_API_KEY', 'example-api-key');
  vi.stubEnv('VITE_FIREBASE_AUTH_DOMAIN', 'example.firebaseapp.com');
  vi.stubEnv('VITE_FIREBASE_PROJECT_ID', 'example');
  vi.stubEnv('VITE_FIREBASE_APP_ID', 'example-web-app');
  sdk.authStateReady.mockResolvedValue(undefined);
  sdk.Provider.credentialFromResult.mockImplementation(result => result.providerCredential);
});
afterEach(async () => {
  await signOutGitHubHostedAuth();
  vi.unstubAllEnvs();
});

describe('hosted GitHub authorization', () => {
  it('requires the full public configuration and permits signing out an unused deployment', async () => {
    expect(hasGitHubHostedAuth()).toBe(true);
    vi.stubEnv('VITE_FIREBASE_PROJECT_ID', ' ');
    expect(hasGitHubHostedAuth()).toBe(false);
    await expect(prepareGitHubHostedAuth()).rejects.toThrow('尚未配置');
    await signOutGitHubHostedAuth();
    expect(sdk.initializeApp).not.toHaveBeenCalled();
    expect(sdk.signOut).not.toHaveBeenCalled();
  });

  it.each([['public', 'public_repo'], ['private', 'repo']] as const)('opens the prepared popup with %s access', async (access, scope) => {
    await Promise.all([prepareGitHubHostedAuth(), prepareGitHubHostedAuth()]);
    expect(sdk.initializeApp).toHaveBeenCalledOnce();
    expect(sdk.initializeAuth).toHaveBeenCalledWith(expect.objectContaining({ name: expect.stringMatching(/^gonglun-github-/) }),
      { persistence: sdk.inMemoryPersistence, popupRedirectResolver: sdk.browserPopupRedirectResolver });
    sdk.signInWithPopup.mockResolvedValue({ providerCredential: { accessToken: 'test-github-token' }, user: { accessToken: 'test-firebase-token' } });
    const outcome = authorizeGitHub(access);
    expect(sdk.signInWithPopup).toHaveBeenCalledOnce();
    expect(sdk.signInWithPopup.mock.calls[0][1].addScope).toHaveBeenCalledExactlyOnceWith(scope);
    await expect(outcome).resolves.toBe('test-github-token');
  });

  it.each([
    ['auth/popup-closed-by-user', '取消'],
    ['auth/user-cancelled', '拒绝'],
    ['auth/unauthorized-domain', '授权域名'],
    ['auth/web-storage-unsupported', '网站存储'],
    ['auth/unknown', '未完成'],
  ])('provides a safe actionable message for %s', async (code, message) => {
    await prepareGitHubHostedAuth();
    sdk.signInWithPopup.mockRejectedValue({ code, message: 'private-provider-payload', customData: { accessToken: 'sensitive' } });
    const failure = await authorizeGitHub('public').catch(error => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(message);
    expect((failure as Error).message).not.toMatch(/private-provider-payload|sensitive/);
  });

  it('drops callbacks from a signed-out popup without affecting a newer login', async () => {
    await prepareGitHubHostedAuth();
    let finishOld!: (result: unknown) => void;
    sdk.signInWithPopup.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const old = authorizeGitHub('private');
    await signOutGitHubHostedAuth();
    expect(sdk.signOut).toHaveBeenCalledExactlyOnceWith(sdk.initializeAuth.mock.results[0].value);
    expect(sdk.deleteApp).toHaveBeenCalledExactlyOnceWith(sdk.initializeApp.mock.results[0].value);
    await prepareGitHubHostedAuth();
    expect(sdk.initializeApp.mock.calls[1][1]).not.toBe(sdk.initializeApp.mock.calls[0][1]);
    sdk.signInWithPopup.mockResolvedValueOnce({ providerCredential: { accessToken: 'new-token' } });
    await expect(authorizeGitHub('public')).resolves.toBe('new-token');
    finishOld({ providerCredential: { accessToken: 'old-token' } });
    await expect(old).rejects.toThrow('已退出');
    expect(sdk.signOut).toHaveBeenCalledTimes(1);
  });

  it('signs out only the old instance when a previous initialization finishes late', async () => {
    let finishSetup!: () => void;
    sdk.authStateReady.mockImplementationOnce(() => new Promise<void>(resolve => { finishSetup = resolve; }));
    const old = prepareGitHubHostedAuth();
    await vi.waitFor(() => expect(sdk.authStateReady).toHaveBeenCalledOnce());
    const closing = signOutGitHubHostedAuth();
    await prepareGitHubHostedAuth();
    finishSetup();
    await Promise.all([old, closing]);
    expect(sdk.signOut).toHaveBeenCalledExactlyOnceWith(sdk.initializeAuth.mock.results[0].value);
    sdk.signInWithPopup.mockResolvedValueOnce({ providerCredential: { accessToken: 'new-token' } });
    await expect(authorizeGitHub('private')).resolves.toBe('new-token');
    expect(sdk.signInWithPopup.mock.calls[0][0]).toBe(sdk.initializeAuth.mock.results[1].value);
  });

  it('can retry a failed setup without retaining the failed auth instance', async () => {
    sdk.authStateReady.mockRejectedValueOnce({ code: 'auth/network-request-failed' });
    await expect(prepareGitHubHostedAuth()).rejects.toThrow('检查网络');
    expect(sdk.deleteApp).toHaveBeenCalledOnce();
    await prepareGitHubHostedAuth();
    sdk.signInWithPopup.mockResolvedValueOnce({ user: {} });
    await expect(authorizeGitHub('public')).rejects.toThrow('未返回仓库访问凭据');
  });
});
