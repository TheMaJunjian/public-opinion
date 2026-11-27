import { GitHubRequestError, githubRepositoryUrl } from './gitMeetingTransport';

export type GitHubRepositoryVisibility = 'private' | 'public';

const unconfirmed = '仓库创建结果尚未确认。请先到 GitHub 查看个人仓库。若已创建，可复制仓库地址回公论继续新建讨论。';

export async function createGitHubRepository(
  name: string,
  visibility: GitHubRepositoryVisibility,
  token: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const repositoryName = name.trim();
  if (!/^[\w.-]{1,100}$/.test(repositoryName) || /^\.+$|\.git$/i.test(repositoryName)) {
    throw new Error('请填写 1 至 100 位的仓库名称，可用英文字母、数字、点、短横线和下划线。请输入不带 .git 后缀的名称。');
  }
  if (visibility !== 'private' && visibility !== 'public') throw new Error('请选择仓库的可见范围。');
  const credential = token.trim();
  if (!credential) throw new Error('请先授权 GitHub 创建仓库。');

  // GitHub determines the personal account from this credential. A POST can
  // succeed before a network interruption, so never retry or adopt a namesake.
  let response: Response;
  try {
    response = await fetch('https://api.github.com/user/repos', {
      method: 'POST', signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: {
        Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', Authorization: 'Bearer ' + credential,
      },
      body: JSON.stringify({ name: repositoryName, private: visibility === 'private', has_issues: true, auto_init: true }),
    });
  } catch (cause) {
    signal.throwIfAborted();
    throw new Error(unconfirmed, { cause });
  }
  signal.throwIfAborted();
  if (response.status === 401) {
    const error = await GitHubRequestError.from(response);
    error.message = 'GitHub 授权无效或已过期，请重新授权。';
    throw error;
  }
  if (response.status === 422) {
    const failure = await response.json().catch(() => null);
    const duplicate = Array.isArray(failure?.errors) && failure.errors.some(
      (error: { field?: string; code?: string; message?: string } | null) =>
        error?.field === 'name' && (error.code === 'already_exists' || /already exists/i.test(error.message ?? '')),
    );
    if (duplicate) throw new Error('这个 GitHub 账号下已有同名仓库。请选择其他名称，或使用已有仓库的地址新建讨论。');
    throw new Error('GitHub 未能创建仓库，请检查仓库名及账号的建仓限制。');
  }
  if (response.status >= 500 || response.status === 408) throw new Error(unconfirmed);
  if (!response.ok) {
    const error = await GitHubRequestError.from(response);
    if (response.status === 403 && !error.retryAt) throw new Error('GitHub 拒绝建仓，请检查账号是否有建仓权限，以及授权是否包含所选的仓库可见范围。');
    throw error;
  }

  const repository = await response.json().catch(() => null);
  signal.throwIfAborted();
  const owner = repository?.owner?.login;
  if (response.status !== 201 || typeof owner !== 'string' || !/^[\w-]+$/.test(owner)
    || repository.private !== (visibility === 'private') || typeof repository.full_name !== 'string'
    || typeof repository.html_url !== 'string') {
    throw new Error(unconfirmed);
  }
  const fullName = (owner + '/' + repositoryName).toLowerCase();
  if (repository.full_name.toLowerCase() !== fullName || repository.html_url.toLowerCase() !== 'https://github.com/' + fullName) {
    throw new Error(unconfirmed);
  }
  return githubRepositoryUrl(fullName);
}
