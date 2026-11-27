import type { FirebaseOptions } from 'firebase/app';
import type { GitHubAccess } from './gitMeetingSession';

function firebaseOptions(): FirebaseOptions | undefined {
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY?.trim();
  const authDomain = import.meta.env.VITE_FIREBASE_AUTH_DOMAIN?.trim();
  const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID?.trim();
  const appId = import.meta.env.VITE_FIREBASE_APP_ID?.trim();
  if (apiKey && authDomain && projectId && appId) return { apiKey, authDomain, projectId, appId };
}

export function hasGitHubHostedAuth() {
  return firebaseOptions() !== undefined;
}

function authMessage(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : '';
  switch (code) {
    case 'auth/cancelled-popup-request':
    case 'auth/popup-closed-by-user':
    case 'auth/redirect-cancelled-by-user':
      return '已取消 GitHub 授权。';
    case 'access_denied':
    case 'auth/access-denied':
    case 'auth/user-cancelled':
    case 'auth/user-disabled':
      return 'GitHub 登录或仓库授权被拒绝，请检查账号与授权设置。';
    case 'auth/popup-blocked':
      return '浏览器拦截了 GitHub 登录弹窗，请允许弹窗后再点授权。';
    case 'auth/unauthorized-domain':
      return '当前公论网址尚未加入 Firebase 的授权域名，请联系部署者。';
    case 'auth/invalid-api-key':
    case 'auth/auth-domain-config-required':
    case 'auth/configuration-not-found':
    case 'auth/operation-not-allowed':
      return '此站点的 GitHub 登录配置尚未就绪，请联系部署者检查 Firebase 设置。';
    case 'auth/web-storage-unsupported':
    case 'auth/operation-not-supported-in-this-environment':
      return '当前浏览器限制了登录窗口或网站存储，请使用普通浏览窗口再试。';
    case 'auth/network-request-failed':
      return '连接托管登录服务失败，请检查网络后重试。';
    case 'auth/account-exists-with-different-credential':
      return '这个邮箱在托管登录服务中已关联其他登录方式，请联系部署者处理账号关联。';
    default:
      // A raw provider error can contain email addresses, OAuth responses or credentials.
      return 'GitHub 授权未完成，请重新授权。';
  }
}

async function createClient(options: FirebaseOptions) {
  const [{ initializeApp, deleteApp }, { initializeAuth, inMemoryPersistence, GithubAuthProvider,
    browserPopupRedirectResolver, signInWithPopup, signOut }] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
  // Separate Auth instances ensure an old popup cannot sign in a newer session after logout.
  const app = initializeApp(options, 'gonglun-github-' + crypto.randomUUID());
  try {
    const auth = initializeAuth(app, { persistence: inMemoryPersistence, popupRedirectResolver: browserPopupRedirectResolver });
    await auth.authStateReady();
    return {
      async authorize(access: GitHubAccess) {
        const provider = new GithubAuthProvider();
        provider.addScope(access === 'private' ? 'repo' : 'public_repo');
        const result = await signInWithPopup(auth, provider);
        return GithubAuthProvider.credentialFromResult(result)?.accessToken;
      },
      async close() {
        try { await signOut(auth); }
        finally { await deleteApp(app); }
      },
    };
  } catch (error) {
    await deleteApp(app);
    throw error;
  }
}

type HostedClient = Awaited<ReturnType<typeof createClient>>;
let initialization: Promise<HostedClient> | undefined;
let ready: HostedClient | undefined;

/** Preload before enabling the button so opening the popup retains the user's activation. */
export async function prepareGitHubHostedAuth(): Promise<void> {
  const options = firebaseOptions();
  if (!options) throw new Error('此站点尚未配置托管 GitHub 登录。');
  const attempt = initialization ??= createClient(options);
  try {
    const client = await attempt;
    if (attempt === initialization) ready = client;
  } catch (error) {
    if (attempt === initialization) initialization = undefined;
    throw new Error(authMessage(error));
  }
}

export async function authorizeGitHub(access: GitHubAccess): Promise<string> {
  const client = ready;
  if (!client) throw new Error('GitHub 登录尚未就绪，请重新打开授权入口。');
  let token;
  try { token = await client.authorize(access); }
  catch (error) { throw new Error(authMessage(error)); }
  if (ready !== client) throw new Error('本次授权期间已退出，请重新授权。');
  if (!token) throw new Error('GitHub 未返回仓库访问凭据，请重新授权。');
  return token;
}

export async function signOutGitHubHostedAuth(): Promise<void> {
  const attempt = initialization;
  initialization = undefined;
  ready = undefined;
  const client = await attempt?.catch(() => undefined);
  if (client) {
    try { await client.close(); }
    catch { throw new Error('托管登录会话未能正常退出，请刷新当前页面。'); }
  }
}
