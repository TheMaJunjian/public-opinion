import { useLayoutEffect, useRef, useState } from 'react';
import type { ExportData } from '../api/client';
import { createMeetingStart, exportMeetingDelta, importMeetingDelta, MAX_MEETING_BYTES } from '../utils/meetingExchange';
import { downloadExport } from '../utils/saveExport';
import { blobBytes } from '../utils/streamJsonArchive';
import { supportsDirectoryPicker } from '../utils/directoryPicker';
import { useMeetingDirectorySync } from '../hooks/useMeetingDirectorySync';
import { useWpsMeetingSync } from '../hooks/useWpsMeetingSync';
import { useGitMeetingSync } from '../hooks/useGitMeetingSync';
import { setGitMeetingToken, type GitHubAccess } from '../utils/gitMeetingSession';
import { useGitHubAuthorization } from '../hooks/useGitHubAuthorization';
import { GitHubAccessField, GitTokenField } from './GitHubAccessFields';
import { gitMeetingIssueUrl } from '../utils/gitMeetingComments';
import { dialogStyles } from './dialogStyles';
import PromptModal from './PromptModal';

function GitMeetingAccess({ git }: { git: NonNullable<ReturnType<typeof useGitMeetingSync>> }) {
  const [token, setToken] = useState('');
  const [notice, setNotice] = useState('');
  const { repository } = git.source;
  const issueUrl = gitMeetingIssueUrl(git.source);
  const [access, setAccess] = useState<GitHubAccess>('public');
  const [connecting, setConnecting] = useState(false);
  const [authError, setAuthError] = useState('');
  const operation = useRef<AbortController | null>(null);
  const auth = useGitHubAuthorization(true, access);
  useLayoutEffect(() => () => operation.current?.abort(), []);
  async function connect() {
    if (operation.current) return;
    const controller = new AbortController();
    operation.current = controller;
    setConnecting(true); setAuthError('');
    try {
      const granted = await auth.connect(controller.signal, git.authenticated);
      controller.signal.throwIfAborted();
      setGitMeetingToken(repository, granted);
    } catch (error) {
      if (!controller.signal.aborted) setAuthError(error instanceof Error ? error.message : 'GitHub 授权失败。');
    } finally {
      operation.current = null;
      if (!controller.signal.aborted) setConnecting(false);
    }
  }
  return <>
    <strong>GitHub 讨论</strong>
    <a href={issueUrl} target="_blank" rel="noreferrer" style={{ overflowWrap: 'anywhere' }}>{issueUrl}</a>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      <button type="button" style={dialogStyles.button} onClick={git.syncNow}>立即同步</button>
      <button type="button" style={dialogStyles.button} onClick={async () => {
        try {
          await navigator.clipboard.writeText(issueUrl);
          setNotice('已复制讨论链接，可发给参与者。');
        } catch { setNotice('请复制上方讨论链接给参与者。'); }
      }}>复制加入信息</button>
    </div>
    {notice && <small role="status">{notice}</small>}
    {git.report && <small role={git.report.failed ? 'alert' : 'status'}>{git.report.message}</small>}
    {auth.enabled && <>
      <GitHubAccessField access={access} onChange={setAccess} disabled={connecting} />
      <button type="button" style={dialogStyles.button} disabled={connecting || !auth.ready} onClick={() => void connect()}>
        {connecting ? '正在授权…' : git.authenticated ? '重新授权 GitHub' : '连接 GitHub 以发言'}
      </button>
      {auth.error && <span role="alert">{auth.error} <button type="button" onClick={auth.retry}>重试加载授权</button></span>}
      {authError && <span role="alert">{authError}</span>}
    </>}
    <details>
      <summary>{auth.enabled ? '使用个人访问令牌' : git.authenticated ? '管理当前页面的 GitHub 令牌' : '连接 GitHub 令牌以发言'}</summary>
      <form className="git-meeting-form" onSubmit={event => {
        event.preventDefault();
        if (token.trim()) { setGitMeetingToken(repository, token.trim()); setToken(''); }
      }}>
        <GitTokenField token={token} onChange={setToken} />
        <button type="submit" style={dialogStyles.button} disabled={!token.trim()}>连接令牌</button>
        {git.authenticated && <button type="button" style={dialogStyles.button}
          onClick={() => { setGitMeetingToken(repository, ''); setToken(''); }}>清除此仓库的令牌</button>}
      </form>
    </details>
  </>;
}

export default function OfflineMeetingExchange({ data, onSave, viewerInstanceKey }: {
  data: ExportData; onSave(data: ExportData, expected?: ExportData): Promise<void>; viewerInstanceKey?: string;
}) {
  const git = useGitMeetingSync(data, onSave);
  const wps = useWpsMeetingSync(data, onSave);
  const sync = useMeetingDirectorySync(data, onSave, viewerInstanceKey, !git && !wps);
  const report = git?.report ?? wps ?? sync.report;
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const lock = useRef(false), trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { if (open) closeButton.current?.focus({ preventScroll: true }); }, [open]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  async function run(work: () => Promise<string>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try { setNotice(await work()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '会议文件处理失败'); }
    finally { lock.current = false; setBusy(false); }
  }
  const save = (value: unknown, name: string) => {
    const file = new Blob([JSON.stringify(value)], { type: 'application/json' });
    if (file.size > MAX_MEETING_BYTES) throw new Error('会议文件超过 32 MiB，无法交换。');
    downloadExport(file, name);
  };
  return <>
    <button ref={trigger} type="button" className="workbench-toolbar-action" style={dialogStyles.button}
      aria-haspopup="dialog" aria-expanded={open} aria-label="会议交换" title={git?.report?.message ?? wps?.message ?? (sync.directory ? `${sync.directory.name} · ${sync.report?.message ?? '等待同步'}` : undefined)}
      onClick={() => { setNotice(''); setError(''); setOpen(true); }}>会议交换{(git || wps || sync.directory) && (report?.failed ? ' · 待同步' : ' · 自动')}</button>
    <PromptModal open={open} title={git ? 'Git 仓库同步' : wps ? 'WPS 云文档同步' : '离线会议交换'} closeOnly confirmButtonRef={closeButton} onConfirm={close}
      dialogProps={{ onKeyDown: event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key === 'Tab') {
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:enabled, input:enabled, select:enabled, a[href], summary')]
            .filter(control => !control.closest('details:not([open])') || control.tagName === 'SUMMARY');
          const first = controls[0], last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      } }}
      message={<div style={{ display: 'grid', gap: 10, whiteSpace: 'normal' }}>
        {git ? <GitMeetingAccess key={gitMeetingIssueUrl(git.source)} git={git} /> : <>
        <p style={{ margin: 0 }}>{wps ? '发言和回复会同步到当前 WPS 云表。' : '会议文件交换本地文字和整条发言之间的回复。'}发言人使用自填署名，未经账号签名验证。收到文件的人可以阅读并转发其中的发言。</p>
        {data.meeting ? <>
          <small>会议编号 {data.meeting.id}</small>
          {!wps && (sync.directory ? <>
            <strong>自动同步 · {sync.directory.name}</strong>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              <button type="button" style={dialogStyles.button} disabled={sync.syncing} onClick={() => void sync.syncNow()}>立即同步</button>
              <button type="button" style={dialogStyles.button} onClick={sync.disconnect}>停止自动同步</button>
            </div>
          </> : supportsDirectoryPicker() ? <>
            <button type="button" style={dialogStyles.button} disabled={sync.picking} onClick={() => void sync.connect()}>连接共享文件夹</button>
            <small>每人选择同一个可读写的局域网共享目录。关闭此窗口后，会议页面仍会自动收发。</small>
          </> : <small>当前浏览器未提供文件夹读写功能，可继续用下方按钮手动交换。</small>)}
          {(report || sync.directory) && <small role={report?.failed && !sync.syncing ? 'alert' : undefined} style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere' }}>
            {sync.syncing ? '正在检查共享文件夹…' : report?.message ?? '等待同步'}
          </small>}
          <button type="button" style={dialogStyles.button} disabled={busy} onClick={() => void run(async () => {
            const delta = await exportMeetingDelta(data);
            if (!delta.entries.length) return '目前还没有起始文件之后的新记录。';
            save(delta, `会议增量-${delta.meetingId}-${crypto.randomUUID()}.json`);
            return `已生成 ${delta.entries.length} 条记录的增量，包含已合并的发言。`;
          })}>导出累计增量</button>
          {!wps && <label>导入他人的会议增量
            <input type="file" accept=".json,application/json" disabled={busy} style={{ display: 'block', maxWidth: '100%' }}
              onChange={event => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                if (file) void run(async () => {
                  if (file.size > MAX_MEETING_BYTES) throw new Error('会议文件超过 32 MiB。');
                  const text = new TextDecoder('utf-8', { fatal: true }).decode(await blobBytes(file));
                  const merged = await importMeetingDelta(data, JSON.parse(text));
                  if (merged.added) await onSave(merged.data, data);
                  return merged.added ? `已合并 ${merged.added} 条新记录。` : '这份增量的记录已全部导入。';
                });
              }} />
          </label>}
        </> : <>
          <p style={{ margin: 0 }}>用空白本地文件或已有的本地发言准备起点。生成后，将同一份起始文件分给每位成员，自己也从“阅览”打开该文件。</p>
          <button type="button" disabled={busy} style={dialogStyles.button} onClick={() => void run(async () => {
            const start = await createMeetingStart(data);
            save(start, `会议起始-${start.meeting!.id}.json`);
            return '已生成会议起始文件。请全组打开同一份文件，每人填写自己的本地发言人，再开始发言。';
          })}>生成会议起始文件</button>
        </>}
        </>}
        {notice && <span role="status">{notice}</span>}
        {error && <span role="alert">{error}</span>}
      </div>} />
  </>;
}
