import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import GitMeetingChooser from '../components/GitMeetingChooser';
import { authorizeGitHub, prepareGitHubHostedAuth } from '../utils/githubHostedAuth';
import { createGitHubRepository } from '../utils/githubRepository';
import { clearGitMeetingTokens, getGitHubGrant, gitMeetingToken } from '../utils/gitMeetingSession';
import { GitHubRequestError } from '../utils/gitMeetingTransport';
import { GitIssueCreationUnconfirmed } from '../utils/gitMeetingComments';
import { createGitIssueDocument, openGitIssueDocument } from '../utils/gitMeetingIssueDocument';
import GitMeetingGuide from '../components/GitMeetingGuide';
import { createLocalMessageFile } from '../utils/localMessageFile';

vi.mock('../utils/githubHostedAuth', () => ({
  hasGitHubHostedAuth: () => true, prepareGitHubHostedAuth: vi.fn(), authorizeGitHub: vi.fn(),
  signOutGitHubHostedAuth: vi.fn(),
}));
vi.mock('../utils/githubRepository', () => ({ createGitHubRepository: vi.fn() }));
vi.mock('../utils/gitMeetingIssueDocument', () => ({ createGitIssueDocument: vi.fn(), openGitIssueDocument: vi.fn() }));

const repository = 'https://github.com/group/room';
const source = { repository, issue: 7 };
const invitation = repository + '/issues/7';
const token = 'mock-hosted-grant';
const room = createLocalMessageFile();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(prepareGitHubHostedAuth).mockResolvedValue(undefined);
  vi.mocked(authorizeGitHub).mockResolvedValue(token);
  vi.mocked(openGitIssueDocument).mockResolvedValue(room);
  vi.mocked(createGitIssueDocument).mockResolvedValue({ source, start: room });
  vi.mocked(createGitHubRepository).mockResolvedValue(repository);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected request outside hosted login / GitHub transports'); }));
  vi.spyOn(Storage.prototype, 'setItem');
});

afterEach(() => {
  try {
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(Storage.prototype.setItem).mock.calls)).not.toContain(token);
  } finally {
    cleanup(); clearGitMeetingTokens(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  }
});

async function openChooser() {
  const onOpen = vi.fn().mockResolvedValue(undefined);
  const view = render(<GitMeetingChooser disabled={false} onOpen={onOpen} />);
  fireEvent.click(screen.getByText('使用 GitHub 仓库', { selector: 'summary' }));
  await waitFor(() => expect(prepareGitHubHostedAuth).toHaveBeenCalled());
  return { onOpen, unmount: view.unmount };
}

function fill(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

async function clickAction(name: string | RegExp) {
  const button = screen.getByRole('button', { name });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

it('opens an explicitly read-only public discussion without authorizing or creating anything', async () => {
  const { onOpen } = await openChooser();
  fill('GitHub 讨论链接', invitation);
  await clickAction('只读进入公开讨论');
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(room, source, expect.any(AbortSignal)));
  expect(openGitIssueDocument).toHaveBeenCalledWith(source, '', expect.any(AbortSignal));
  expect(authorizeGitHub).not.toHaveBeenCalled();
  expect(createGitHubRepository).not.toHaveBeenCalled();
  expect(getGitHubGrant()).toBeNull();
});

it('waits for explicit approval, allows a cancelled user to retry, and reuses that grant for a second discussion', async () => {
  const first = await openChooser();
  fill('GitHub 讨论链接', invitation);
  expect(authorizeGitHub).not.toHaveBeenCalled();
  vi.mocked(authorizeGitHub).mockRejectedValueOnce(new Error('已取消 GitHub 授权'));
  await clickAction('GitHub 授权并进入讨论');
  expect(await screen.findByRole('alert')).toHaveTextContent('已取消 GitHub 授权');
  expect(openGitIssueDocument).not.toHaveBeenCalled();
  expect(createGitHubRepository).not.toHaveBeenCalled();
  expect(getGitHubGrant()).toBeNull();

  await clickAction('GitHub 授权并进入讨论');
  await waitFor(() => expect(first.onOpen).toHaveBeenCalledWith(room, source, expect.any(AbortSignal)));
  expect(gitMeetingToken(repository)).toBe(token);
  first.unmount();

  const second = await openChooser();
  const other = { ...source, repository: 'https://github.com/group/another' };
  fill('GitHub 讨论链接', other.repository + '/issues/' + other.issue);
  await clickAction(/^进入讨论$/);
  await waitFor(() => expect(second.onOpen).toHaveBeenCalledWith(room, other, expect.any(AbortSignal)));
  expect(openGitIssueDocument).toHaveBeenLastCalledWith(other, token, expect.any(AbortSignal));
  expect(authorizeGitHub).toHaveBeenCalledTimes(2);
  expect(createGitHubRepository).not.toHaveBeenCalled();
});

it('creates a private repository by default and resumes at the Issue step after a partial success', async () => {
  const { onOpen } = await openChooser();
  fireEvent.click(screen.getByLabelText('新建讨论'));
  fill('新仓库名称', 'room');
  fill('讨论名称', '会议');
  vi.mocked(createGitIssueDocument).mockRejectedValueOnce(new Error('暂时无法创建 Issue'));
  await clickAction('GitHub 授权并创建仓库和讨论');
  await screen.findByText(/暂时无法创建 Issue/);
  expect(createGitHubRepository).toHaveBeenCalledWith('room', 'private', token, expect.any(AbortSignal));
  expect(onOpen).not.toHaveBeenCalled();
  expect(screen.getByLabelText('GitHub 仓库地址')).toHaveValue(repository);
  expect(screen.getByLabelText('讨论名称')).toHaveValue('会议');
  await clickAction(/^(?:创建讨论|创建并进入讨论)$/);
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(room, source, expect.any(AbortSignal)));
  expect(createGitIssueDocument).toHaveBeenLastCalledWith(repository, '会议', token, expect.any(AbortSignal));
  expect(createGitIssueDocument).toHaveBeenCalledTimes(2);
  expect(authorizeGitHub).toHaveBeenCalledTimes(1);
  expect(createGitHubRepository).toHaveBeenCalledTimes(1);
});

it('uses the requested public visibility and stops before creating an Issue on a name collision', async () => {
  const { onOpen } = await openChooser();
  fireEvent.click(screen.getByLabelText('新建讨论'));
  fill('新仓库名称', 'room');
  fill('讨论名称', '会议');
  fill('仓库可见性', 'public');
  vi.mocked(createGitHubRepository).mockRejectedValue(new Error('已有同名仓库'));
  await clickAction('GitHub 授权并创建仓库和讨论');
  await screen.findByText(/已有同名仓库/);
  expect(authorizeGitHub).toHaveBeenCalledWith('public');
  expect(createGitHubRepository).toHaveBeenCalledWith('room', 'public', token, expect.any(AbortSignal));
  expect(createGitIssueDocument).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
});

it('offers to open the existing Issue after an ambiguous create response', async () => {
  const { onOpen } = await openChooser();
  fireEvent.click(screen.getByLabelText('新建讨论'));
  fill('新仓库名称', 'room');
  fill('讨论名称', '会议');
  vi.mocked(createGitIssueDocument).mockRejectedValueOnce(new GitIssueCreationUnconfirmed(repository));
  await clickAction('GitHub 授权并创建仓库和讨论');
  expect(await screen.findByRole('link', { name: '查看仓库的 Issues' })).toHaveAttribute('href', repository + '/issues');
  expect(screen.getByLabelText('进入已有讨论')).toBeChecked();
  fill('GitHub 讨论链接', invitation);
  await clickAction('进入讨论');
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(room, source, expect.any(AbortSignal)));
  expect(createGitHubRepository).toHaveBeenCalledTimes(1);
  expect(createGitIssueDocument).toHaveBeenCalledTimes(1);
});

it('discards a late approval after closing the chooser', async () => {
  let finish!: (value: string) => void;
  vi.mocked(authorizeGitHub).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const { onOpen, unmount } = await openChooser();
  fill('GitHub 讨论链接', invitation);
  await clickAction('GitHub 授权并进入讨论');
  await waitFor(() => expect(authorizeGitHub).toHaveBeenCalledOnce());
  unmount();
  await act(async () => { finish(token); });
  expect(openGitIssueDocument).not.toHaveBeenCalled();
  expect(getGitHubGrant()).toBeNull();
  expect(onOpen).not.toHaveBeenCalled();
});

it('requests fresh GitHub authorization before retrying a rejected repository creation', async () => {
  const { onOpen } = await openChooser();
  fireEvent.click(screen.getByLabelText('新建讨论'));
  fill('新仓库名称', 'room');
  fill('讨论名称', '会议');
  vi.mocked(createGitHubRepository).mockRejectedValueOnce(new GitHubRequestError(401, new Response(null, { status: 401 })));
  await clickAction('GitHub 授权并创建仓库和讨论');
  await screen.findByRole('alert');
  expect(getGitHubGrant()).toBeNull();
  expect(createGitIssueDocument).not.toHaveBeenCalled();
  vi.mocked(authorizeGitHub).mockResolvedValueOnce(token + '-renewed');
  await clickAction('GitHub 授权并创建仓库和讨论');
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(room, source, expect.any(AbortSignal)));
  expect(authorizeGitHub).toHaveBeenCalledTimes(2);
  expect(createGitHubRepository).toHaveBeenLastCalledWith('room', 'private', token + '-renewed', expect.any(AbortSignal));
});

it('creates a separate Issue in an existing repository without asking for an archive path', async () => {
  const { onOpen } = await openChooser();
  fireEvent.click(screen.getByLabelText('新建讨论'));
  fireEvent.click(screen.getByLabelText('同时新建个人 GitHub 仓库'));
  fill('GitHub 仓库地址', repository);
  fill('讨论名称', '工作汇报');
  expect(screen.queryByLabelText('仓库内的讨论文件')).not.toBeInTheDocument();
  await clickAction('GitHub 授权并创建讨论');
  await waitFor(() => expect(onOpen).toHaveBeenCalledWith(room, source, expect.any(AbortSignal)));
  expect(createGitIssueDocument).toHaveBeenCalledWith(repository, '工作汇报', token, expect.any(AbortSignal));
  expect(createGitHubRepository).not.toHaveBeenCalled();
});

it('reopens a created Issue after a local failure without creating another Issue', async () => {
  const { onOpen } = await openChooser();
  onOpen.mockRejectedValueOnce(new Error('本机暂时无法缓存讨论'));
  fireEvent.click(screen.getByLabelText('新建讨论'));
  fill('新仓库名称', 'room');
  fill('讨论名称', '周会');
  await clickAction('GitHub 授权并创建仓库和讨论');
  expect(await screen.findByRole('alert')).toHaveTextContent('本机暂时无法缓存讨论');
  expect(screen.getByLabelText('GitHub 讨论链接')).toHaveValue(invitation);
  await clickAction(/^进入讨论$/);
  await waitFor(() => expect(onOpen).toHaveBeenCalledTimes(2));
  expect(createGitIssueDocument).toHaveBeenCalledTimes(1);
  expect(openGitIssueDocument).toHaveBeenCalledWith(source, token, expect.any(AbortSignal));
});

it('validates a discussion invitation before asking the user to authorize', async () => {
  const { onOpen } = await openChooser();
  fill('GitHub 讨论链接', repository);
  await clickAction('GitHub 授权并进入讨论');
  expect(await screen.findByRole('alert')).toHaveTextContent(/Issue|讨论链接|讨论地址/i);
  expect(authorizeGitHub).not.toHaveBeenCalled();
  expect(openGitIssueDocument).not.toHaveBeenCalled();
  expect(onOpen).not.toHaveBeenCalled();
});

it('explains optional per-Issue archives and provides least-privilege token links in the reading guide', () => {
  render(<GitMeetingGuide hosted />);
  fireEvent.click(screen.getByText('首次使用 GitHub', { selector: 'summary' }));
  fireEvent.click(screen.getByText('改用个人访问令牌', { selector: 'summary' }));
  const read = screen.getByRole<HTMLAnchorElement>('link', { name: '创建只读令牌' });
  const write = screen.getByRole<HTMLAnchorElement>('link', { name: '创建发言令牌' });
  expect(new URL(read.href).searchParams.get('issues')).toBe('read');
  expect(new URL(write.href).searchParams.get('issues')).toBe('write');
  expect(new URL(write.href).searchParams.has('contents')).toBe(false);
  expect(new URL(write.href).searchParams.has('actions')).toBe(false);
  fireEvent.click(screen.getByText('为讨论生成 JSONL 归档文件', { selector: 'summary' }));
  expect(screen.getByText('.github/workflows/gonglun-archive.yml')).toBeVisible();
  expect(screen.getByText('gonglun/discussion-17.jsonl')).toBeVisible();
  const download = screen.getByRole<HTMLAnchorElement>('link', { name: '下载讨论归档工作流' });
  expect(download.download).toBe('gonglun-archive.yml');
  expect(new URL(download.href).pathname).toMatch(/\/gonglun-archive\.yml$/);
});
