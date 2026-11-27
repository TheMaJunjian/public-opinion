import { useLayoutEffect, useRef, useState } from 'react';
import type { ExportData } from '../api/client';
import { pickWritableDirectory, supportsDirectoryPicker } from '../utils/directoryPicker';
import { createFolderMeeting, listFolderMeetings, MAX_FOLDER_MEETING_TITLE, openFolderMeeting, type FolderMeeting } from '../utils/meetingFolder';
import { dialogStyles } from './dialogStyles';
import PromptModal from './PromptModal';

type Props = {
  disabled?: boolean;
  onOpen(data: ExportData, directory: FileSystemDirectoryHandle, signal?: AbortSignal): Promise<void>;
};

export default function MeetingFolderDialog({ onOpen, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const [directory, setDirectory] = useState<FileSystemDirectoryHandle | null>(null);
  const [meetings, setMeetings] = useState<FolderMeeting[]>([]);
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState(''), [error, setError] = useState('');
  const operation = useRef<AbortController | null>(null);
  const trigger = useRef<HTMLButtonElement>(null), closeButton = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    setStatus('');
    return () => {
      operation.current?.abort();
      operation.current = null;
    };
  }, []);
  useLayoutEffect(() => { if (open) closeButton.current?.focus({ preventScroll: true }); }, [open]);
  function close() {
    operation.current?.abort();
    operation.current = null;
    setOpen(false);
    setDirectory(null);
    setMeetings([]);
    setTitle('');
    setStatus('');
    setError('');
    trigger.current?.focus();
  }
  async function run(label: string, work: (signal: AbortSignal) => Promise<void>) {
    if (operation.current) return;
    const active = new AbortController();
    operation.current = active;
    setStatus(label);
    setError('');
    try {
      await work(active.signal);
    } catch (cause) {
      if (!active.signal.aborted) {
        const denied = cause instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(cause.name);
        setError(denied ? '没有读写权限。请确认这台电脑能写入共享文件夹，并在选择时允许浏览器读写。'
          : cause instanceof Error ? cause.message : String(cause));
      }
    } finally {
      if (operation.current === active && !active.signal.aborted) {
        operation.current = null;
        setStatus('');
      }
    }
  }
  async function list(folder: FileSystemDirectoryHandle, signal: AbortSignal) {
    const entries = await listFolderMeetings(folder, signal);
    if (!signal.aborted) setMeetings(entries);
  }
  function choose() {
    setOpen(true);
    if (!supportsDirectoryPicker()) {
      setError('当前浏览器无法直接读写共享文件夹。可以用支持目录选择的浏览器打开，或通过“阅览”打开会议起始文件，手动交换增量。');
      return;
    }
    void run('正在选择共享文件夹…', async signal => {
      let selected: FileSystemDirectoryHandle;
      try {
        selected = await pickWritableDirectory('gonglun-meeting');
      } catch (cause) {
        if (typeof cause === 'object' && cause !== null && 'name' in cause && cause.name === 'AbortError') {
          if (!signal.aborted) close();
          return;
        }
        throw cause;
      }
      signal.throwIfAborted();
      setDirectory(selected);
      setStatus('正在读取会议列表…');
      await list(selected, signal);
    });
  }
  function join(entry: FolderMeeting) {
    if (!directory) return;
    void run('正在加入会议…', async signal => {
      const data = await openFolderMeeting(directory, entry, signal);
      signal.throwIfAborted();
      await onOpen(data, directory, signal);
      if (!signal.aborted) close();
    });
  }
  function create() {
    if (!directory || !title.trim()) return;
    void run('正在创建会议…', async signal => {
      const data = await createFolderMeeting(directory, title.trim(), undefined, signal);
      signal.throwIfAborted();
      // Publish the entry before attempting the local cache/navigation. If that
      // second step fails, the existing meeting is available for a safe retry.
      const entry = { id: data.meeting!.id, baseHash: data.meeting!.baseHash, title: data.scope.title, createdAt: data.exportedAt };
      setMeetings(current => [entry, ...current.filter(row => row.id !== entry.id)]);
      setTitle('');
      try {
        await onOpen(data, directory, signal);
      } catch (cause) {
        throw new Error(`会议已创建，可点击会议名重新进入。${cause instanceof Error ? cause.message : String(cause)}`);
      }
      if (!signal.aborted) close();
    });
  }
  return <>
    <button ref={trigger} type="button" disabled={disabled} aria-haspopup="dialog" aria-expanded={open}
      className="viewer-source-action" onClick={choose}>选择共享文件夹</button>
    <PromptModal open={open} title="共享文件夹会议" closeOnly confirmButtonRef={closeButton} onConfirm={close}
      dialogProps={{ onKeyDown: event => {
        event.stopPropagation();
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key === 'Tab') {
          const controls = event.currentTarget.querySelectorAll<HTMLElement>('button:enabled,input:enabled');
          const first = controls[0], last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
          if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
      } }}
      message={<div style={{ display: 'grid', gap: 12, whiteSpace: 'normal' }}>
        {directory && <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <strong style={{ overflowWrap: 'anywhere' }}>{directory.name}</strong>
            <button type="button" style={dialogStyles.button} disabled={!!status}
              onClick={() => void run('正在读取会议列表…', signal => list(directory, signal))}>刷新会议列表</button>
          </div>
          {meetings.length ? <div role="group" aria-label="可加入的会议" style={{ display: 'grid', gap: 6 }}>
            {meetings.map(entry => <button key={entry.id} type="button" disabled={!!status} aria-label={entry.title}
              aria-describedby={`meeting-date-${entry.id}`}
              style={{ ...dialogStyles.button, textAlign: 'left', overflowWrap: 'anywhere' }} onClick={() => join(entry)}>
              <strong>{entry.title}</strong>
              <small id={`meeting-date-${entry.id}`} style={{ display: 'block' }}>{entry.createdAt ? new Date(entry.createdAt).toLocaleString() + ' · ' : ''}{entry.id.slice(0, 8)}</small>
            </button>)}
          </div> : !status && !error && <span>此文件夹还没有会议。</span>}
          <form onSubmit={event => { event.preventDefault(); create(); }} style={{ display: 'grid', gap: 8 }}>
            <label>会议名称<input style={dialogStyles.input} value={title} maxLength={MAX_FOLDER_MEETING_TITLE}
              disabled={!!status} onChange={event => setTitle(event.target.value)} /></label>
            <button type="submit" style={dialogStyles.primaryButton} disabled={!!status || !title.trim()}>创建并进入</button>
          </form>
          <small>其他电脑在“阅览”中选择同一个共享文件夹，点会议名即可加入。</small>
        </>}
        {status && <span role="status">{status}</span>}
        {error && <span role="alert" style={{ overflowWrap: 'anywhere' }}>{error}</span>}
        {!directory && error && supportsDirectoryPicker() && <button type="button" style={dialogStyles.button} onClick={choose}>重新选择共享文件夹</button>}
      </div>} />
  </>;
}
