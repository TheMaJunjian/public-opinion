import type { exportMeetingDelta } from './meetingExchange';

export type GitMeetingDelta = Awaited<ReturnType<typeof exportMeetingDelta>>;

export function githubRepositoryUrl(repositoryUrl: string): string {
  let url: URL;
  const input = repositoryUrl.trim();
  try { url = new URL(/^[\w.-]+\/[\w.-]+$/.test(input) ? 'https://github.com/' + input : input); }
  catch { throw new Error('请输入 GitHub 仓库地址，例如 https://github.com/组织名/仓库名。'); }
  const repo = /^\/([\w-]+)\/([\w.-]+?)\/?$/.exec(url.pathname);
  if (url.origin !== 'https://github.com' || url.username || url.password || url.search || url.hash || !repo) {
    throw new Error('请使用 GitHub 仓库首页的 HTTPS 地址。');
  }
  const name = repo[2].replace(/\.git$/i, '');
  if (!name || /^\.+$/.test(name)) throw new Error('GitHub 仓库名无效。');
  return 'https://github.com/' + repo[1].toLowerCase() + '/' + name.toLowerCase();
}

export class GitHubRequestError extends Error {
  readonly retryAt?: number;
  constructor(readonly status: number, response: Response, rateLimitMessage = false) {
    const limited = status === 429 || (status === 403 &&
      (rateLimitMessage || response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')));
    const descriptions: Record<number, string> = {
      401: 'GitHub 凭证无效或已过期，请重新填写。',
      403: 'GitHub 拒绝操作，请检查账号的仓库访问权限和令牌的 Issues 权限。',
      404: '没有找到 GitHub 仓库或讨论，请检查链接和账号权限。',
      409: 'GitHub 提交发生冲突，请稍后重试。',
      422: 'GitHub 未接受本次请求，请检查仓库是否启用了 Issues。',
    };
    super(limited ? 'GitHub 请求达到限额，请稍后重试。' : descriptions[status] || 'GitHub 请求失败（HTTP ' + status + '）。');
    if (limited) {
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      const delay = Number(response.headers.get('retry-after')) * 1000;
      this.retryAt = Math.max(reset, Date.now() + (delay || 60_000));
    }
  }

  static async from(response: Response) {
    // Some secondary-limit responses lack a Retry-After accessible to a browser.
    const details = response.status === 403 ? await response.json().catch(() => null) : null;
    return new GitHubRequestError(response.status, response, /rate limit|abuse detection/i.test(details?.message || ''));
  }
}
