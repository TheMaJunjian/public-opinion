import { afterEach, expect, it, vi } from 'vitest';
import { createGitHubRepository } from '../utils/githubRepository';
import { GitHubRequestError } from '../utils/gitMeetingTransport';

const signal = new AbortController().signal;
const token = 'mock-oauth';
const repository = {
  owner: { login: 'Discussion-Host' }, full_name: 'Discussion-Host/My-Room',
  html_url: 'https://github.com/Discussion-Host/My-Room', private: true,
};

function mockResponse(status: number, body: unknown, headers?: HeadersInit) {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status, headers }));
  vi.stubGlobal('fetch', request);
  return request;
}
afterEach(() => vi.unstubAllGlobals());

it.each(['private', 'public'] as const)('creates an explicitly %s repository under the authorizing account', async visibility => {
  const request = mockResponse(201, { ...repository, private: visibility === 'private' });
  await expect(createGitHubRepository(' My-Room ', visibility, token, signal)).resolves.toBe('https://github.com/discussion-host/my-room');
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith('https://api.github.com/user/repos', expect.objectContaining({
    method: 'POST', signal, credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    headers: expect.objectContaining({ Authorization: 'Bearer ' + token }),
    body: JSON.stringify({ name: 'My-Room', private: visibility === 'private', has_issues: true, auto_init: true }),
  }));
});

it('requires a supported repository name and authorization before sending anything', async () => {
  const request = vi.fn();
  vi.stubGlobal('fetch', request);
  for (const name of ['owner/project', '..', '', 'project.git', 'a'.repeat(101)]) {
    await expect(createGitHubRepository(name, 'private', token, signal)).rejects.toThrow(/仓库名称/);
  }
  await expect(createGitHubRepository('My-Room', 'public', '', signal)).rejects.toThrow(/请先授权/);
  const cancelled = AbortSignal.abort();
  await expect(createGitHubRepository('My-Room', 'private', token, cancelled)).rejects.toMatchObject({ name: 'AbortError' });
  expect(request).not.toHaveBeenCalled();
});

it('reports an occupied name without adopting the existing repository', async () => {
  const request = mockResponse(422, { errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
  await expect(createGitHubRepository('My-Room', 'private', token, signal)).rejects.toThrow(/已有同名仓库/);
  expect(request).toHaveBeenCalledTimes(1);
});

it('distinguishes expired grants, denied creation and rate limits without retrying or changing visibility', async () => {
  mockResponse(401, {});
  const expired = createGitHubRepository('My-Room', 'private', token, signal);
  await expect(expired).rejects.toBeInstanceOf(GitHubRequestError);
  await expect(expired).rejects.toMatchObject({ status: 401, message: expect.stringContaining('重新授权') });
  for (const [status, body, message] of [
    [403, {}, /建仓权限/], [403, { message: 'secondary rate limit' }, /限额/],
    [429, {}, /限额/], [422, { errors: [{ field: 'name', code: 'invalid' }] }, /建仓限制/],
  ] as const) {
    const request = mockResponse(status, body);
    await expect(createGitHubRepository('My-Room', 'private', token, signal)).rejects.toThrow(message);
    expect(request).toHaveBeenCalledTimes(1);
  }
});

it('requires confirmation of the exact GitHub repository and visibility before returning a write destination', async () => {
  for (const body of [
    null, { ...repository, private: false }, { ...repository, full_name: 'Other/My-Room' },
    { ...repository, html_url: 'https://elsewhere.invalid/Discussion-Host/My-Room' },
    { ...repository, html_url: 'https://github.com/Discussion-Host/My-Room?from=elsewhere' },
  ]) {
    const request = mockResponse(201, body);
    await expect(createGitHubRepository('My-Room', 'private', token, signal)).rejects.toThrow(/结果尚未确认/);
    expect(request).toHaveBeenCalledTimes(1);
  }
});

it('leaves a lost POST response for explicit reconciliation', async () => {
  const request = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError('Connection lost'))
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(new Response('incomplete JSON', { status: 201 }));
  vi.stubGlobal('fetch', request);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await expect(createGitHubRepository('My-Room', 'private', token, signal)).rejects.toThrow(/请先到 GitHub 查看个人仓库/);
    expect(request).toHaveBeenCalledTimes(attempt);
  }
});
