import { useEffect, useRef, useState } from 'react';
import type { ExportData } from '../api/client';
import { githubRepositoryUrl, GitHubRequestError } from '../utils/gitMeetingTransport';
import { GitIssueCreationUnconfirmed, gitMeetingCommentSource, gitMeetingIssueUrl, type GitMeetingCommentSource } from '../utils/gitMeetingComments';
import { createGitIssueDocument, openGitIssueDocument } from '../utils/gitMeetingIssueDocument';
import { clearGitMeetingTokens, gitMeetingToken, setGitMeetingToken, type GitHubAccess } from '../utils/gitMeetingSession';
import { createGitHubRepository } from '../utils/githubRepository';
import { useGitHubAuthorization } from '../hooks/useGitHubAuthorization';
import { dialogStyles } from './dialogStyles';
import GitMeetingGuide from './GitMeetingGuide';
import { GitHubAccessField, GitTokenField } from './GitHubAccessFields';

type Props = {
  disabled: boolean;
  onOpen(start: ExportData, source: GitMeetingCommentSource, signal: AbortSignal): Promise<void>;
};

export default function GitMeetingChooser({ disabled, onOpen }: Props) {
  const [creating, setCreating] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [manual, setManual] = useState(false);
  const [newRepository, setNewRepository] = useState(false);
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<GitHubAccess>('private');
  const [existingAccess, setExistingAccess] = useState<GitHubAccess>('public');
  const [repository, setRepository] = useState('');
  const [invitation, setInvitation] = useState('');
  const [title, setTitle] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const [createdUrl, setCreatedUrl] = useState('');
  const [reviewIssues, setReviewIssues] = useState('');
  const access = creating && newRepository ? visibility : existingAccess;
  const auth = useGitHubAuthorization(expanded && !manual, access);
  const hosted = auth.enabled && !manual;
  const createRepo = hosted && creating && newRepository;
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);

  async function submit(anonymous: boolean) {
    if (disabled || operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    const { signal } = controller;
    setWorking(true);
    setError('');
    try {
      const existing = creating ? undefined : gitMeetingCommentSource(invitation);
      let url = existing?.repository ?? (createRepo ? '' : githubRepositoryUrl(repository));
      const credential = anonymous ? '' : hosted ? await auth.connect(signal) : token.trim() || gitMeetingToken(url);
      signal.throwIfAborted();
      if (creating && !credential) throw new Error('请先授权 GitHub 或填写有 Issues 写权限的令牌，再新建讨论。');
      if (createRepo) {
        url = await createGitHubRepository(name, visibility, credential, signal);
        signal.throwIfAborted();
        setRepository(url);
        setCreatedUrl(url);
        setNewRepository(false);
        setExistingAccess(visibility);
      }
      const { source, start } = existing
        ? { source: existing, start: await openGitIssueDocument(existing, credential, signal) }
        : await createGitIssueDocument(url, title.trim(), credential, signal);
      signal.throwIfAborted();
      setGitMeetingToken(source.repository, credential);
      if (creating) {
        // A local cache or navigation failure after the Issue exists must resume by opening it.
        setInvitation(gitMeetingIssueUrl(source));
        setCreating(false);
        setExistingAccess(access);
      }
      await onOpen(start, source, signal);
    } catch (cause) {
      if (!signal.aborted) {
        if (hosted && !anonymous && cause instanceof GitHubRequestError && cause.status === 401) clearGitMeetingTokens();
        if (cause instanceof GitIssueCreationUnconfirmed) {
          setCreating(false);
          setInvitation('');
          setExistingAccess(access);
          setReviewIssues(cause.repository + '/issues');
        }
        setError(cause instanceof Error ? cause.message : 'GitHub 仓库连接失败，请重新打开。');
      }
    } finally {
      operation.current = null;
      if (!signal.aborted) setWorking(false);
    }
  }
  function selectMode(create: boolean) {
    setCreating(create);
    setReviewIssues('');
    setNewRepository(create && hosted && !repository.trim());
    setError('');
  }
  const fieldsDisabled = disabled || working;
  const complete = creating ? !!title.trim() && !!(createRepo ? name.trim() : repository.trim()) : !!invitation.trim();
  const needsGrant = hosted && !auth.connected;
  const submitLabel = createRepo ? '创建仓库和讨论' : creating ? (needsGrant ? '创建讨论' : '创建并进入讨论') : '进入讨论';
  return <details onToggle={event => { if (event.target === event.currentTarget) setExpanded(event.currentTarget.open); }}>
    <summary className="viewer-source-action">使用 GitHub 仓库</summary>
    <GitMeetingGuide hosted={auth.enabled} />
    <form className="git-meeting-form" onSubmit={event => {
      event.preventDefault();
      const button = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
      void submit(button?.value === 'anonymous');
    }}>
      <fieldset disabled={disabled || working}>
        <legend>讨论操作</legend>
        <label><input type="radio" name="git-discussion-mode" checked={!creating}
          onChange={() => selectMode(false)} />进入已有讨论</label>
        <label><input type="radio" name="git-discussion-mode" checked={creating}
          onChange={() => selectMode(true)} />新建讨论</label>
      </fieldset>
      {hosted && creating && <label> <input type="checkbox" checked={newRepository} disabled={fieldsDisabled}
        onChange={event => { setNewRepository(event.target.checked); setError(''); }} /> 同时新建个人 GitHub 仓库</label>}
      {createRepo ? <>
        <label className="git-meeting-label">新仓库名称
          <input required maxLength={100} pattern="[A-Za-z0-9._\-]+" value={name} disabled={fieldsDisabled}
            placeholder="group-discussion" style={dialogStyles.input} onChange={event => setName(event.target.value)} />
        </label>
        <label className="git-meeting-label">仓库可见性
          <select style={dialogStyles.input} value={visibility} disabled={fieldsDisabled}
            onChange={event => setVisibility(event.target.value as GitHubAccess)}>
            <option value="private">私有 · 仅限有权限的成员</option><option value="public">公开 · 所有人可读</option>
          </select>
        </label>
      </> : <label className="git-meeting-label">{creating ? 'GitHub 仓库地址' : 'GitHub 讨论链接'}
        <input required value={creating ? repository : invitation} disabled={fieldsDisabled} spellCheck={false}
          placeholder={creating ? 'https://github.com/用户名/仓库名' : 'https://github.com/用户名/仓库名/issues/1'}
          style={dialogStyles.input}
          onChange={event => { (creating ? setRepository : setInvitation)(event.target.value); setError(''); }} />
      </label>}
      {creating && createdUrl && repository === createdUrl && !createRepo && <small role="status">GitHub 已创建仓库 {createdUrl}，可继续在这个仓库新建讨论。</small>}
      {creating && <>
        {!hosted && <small>已有仓库可直接使用。首次建仓可先在 GitHub 选择仓库名称、可见范围和协作者。{' '}
          <a href="https://github.com/new" target="_blank" rel="noreferrer">在 GitHub 新建仓库</a>
        </small>}
        <label className="git-meeting-label">讨论名称
          <input value={title} required maxLength={120} disabled={fieldsDisabled} style={dialogStyles.input}
            onChange={event => setTitle(event.target.value)} />
        </label>
      </>}
      {hosted ? <>
        <GitHubAccessField access={access} onChange={createRepo ? undefined : setExistingAccess} disabled={fieldsDisabled} />
        {auth.error && <small role="alert">{auth.error} <button type="button" onClick={auth.retry}>重试加载授权</button></small>}
      </> : <>
        {!auth.enabled && <small>此站点尚未配置 GitHub 托管授权。</small>}
        <GitTokenField token={token} onChange={setToken} disabled={fieldsDisabled} />
      </>}
      {error && <small role="alert" className="viewer-source-error">{error}</small>}
      {reviewIssues && <a href={reviewIssues} target="_blank" rel="noreferrer">查看仓库的 Issues</a>}
      <button type="submit" style={dialogStyles.primaryButton} disabled={fieldsDisabled || !complete || (hosted && !auth.ready)}>
        {working ? '正在连接 GitHub…' : needsGrant ? 'GitHub 授权并' + submitLabel : submitLabel}
      </button>
      {hosted && !creating && <button type="submit" value="anonymous" style={dialogStyles.button}
        disabled={fieldsDisabled || !complete}>只读进入公开讨论</button>}
      {auth.enabled && <button type="button" style={dialogStyles.button} disabled={fieldsDisabled}
        onClick={() => { setManual(!manual); setNewRepository(false); setToken(''); setError(''); }}>
        {manual ? '改用 GitHub 授权' : '改用个人访问令牌'}
      </button>}
    </form>
  </details>;
}
