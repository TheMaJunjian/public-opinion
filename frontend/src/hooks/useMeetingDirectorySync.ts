import { useLayoutEffect, useRef, useState } from 'react';
import type { ExportData } from '../api/client';
import { pickWritableDirectory } from '../utils/directoryPicker';
import { MeetingDirectorySync } from '../utils/meetingDirectorySync';
import { takeMeetingDirectory } from '../utils/meetingDirectoryHandoff';

type Save = (next: ExportData, expected: ExportData) => Promise<void>;
type Connection = { directory: FileSystemDirectoryHandle; meeting: string };
type Report = { message: string; failed?: boolean };
const pollIntervalMs = 500;
const errorRetryMs = 5000;

function errorName(error: unknown) {
  return typeof error === 'object' && error !== null && 'name' in error ? String(error.name) : '';
}

function errorMessage(error: unknown) {
  if (['NotAllowedError', 'SecurityError'].includes(errorName(error))) {
    return '文件夹读写权限不可用。请点击“立即同步”重新授权，或重新连接共享文件夹。';
  }
  return error instanceof Error ? error.message : String(error);
}

export function useMeetingDirectorySync(data: ExportData, onSave: Save, viewerInstanceKey?: string) {
  const meetingId = data.meeting?.id;
  const meeting = data.meeting ? `${data.meeting.id}/${data.meeting.baseHash}` : '';
  const [connection, setConnection] = useState<Connection | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [picking, setPicking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const latest = useRef({ data, onSave });
  const lifetime = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const check = useRef<((showProgress?: boolean) => void) | null>(null);
  const directory = connection?.meeting === meeting ? connection.directory : null;

  useLayoutEffect(() => { latest.current = { data, onSave }; }, [data, onSave]);
  useLayoutEffect(() => {
    // A parked workbench can keep its React state. A late picker result belongs
    // only to the meeting and visible page from which it was requested.
    const chosen = takeMeetingDirectory(viewerInstanceKey, meetingId);
    setConnection(current => chosen ? { meeting, directory: chosen } : current?.meeting === meeting ? current : null);
    setPicking(false);
    setSyncing(false);
    setReport(null);
    return () => { lifetime.current++; };
  }, [meeting, meetingId, viewerInstanceKey]);

  useLayoutEffect(() => {
    if (!directory) return;
    const sync = new MeetingDirectorySync(directory);
    const active = new AbortController();
    controller.current = active;
    let running = false, queued = false;
    let timer: number | undefined;
    const isVisible = () => document.visibilityState !== 'hidden';
    const reportResult = (message: string, failed: boolean) => {
      setReport(previous => previous?.message === message && previous.failed === failed ? previous : { message, failed });
    };
    async function run(showProgress = false) {
      if (active.signal.aborted || !isVisible()) return;
      if (showProgress) setSyncing(true);
      if (running) { queued = true; return; }
      window.clearTimeout(timer);
      running = true;
      let nextDelay = pollIntervalMs;
      try {
        const source = latest.current;
        const result = await sync.exchange(source.data, active.signal);
        if (active.signal.aborted) return;
        if (source.data !== latest.current.data) { queued = true; return; }
        if (result.added) await source.onSave(result.data, source.data);
        if (active.signal.aborted) return;
        const details = [`上次同步 ${new Date().toLocaleTimeString()}`];
        if (result.published) details.push(`发出 ${result.published} 条`);
        if (result.added) details.push(`收到 ${result.added} 条`);
        if (result.pending) details.push('仍有增量待同步');
        const message = result.warnings.length
          ? `有 ${result.warnings.length} 项尚未同步。\n${result.warnings.slice(0, 3).join('\n')}`
          : `${details.join('，')}。`;
        reportResult(message, !!result.warnings.length);
      } catch (error) {
        nextDelay = errorRetryMs;
        if (!active.signal.aborted) reportResult(errorMessage(error), true);
      } finally {
        running = false;
        if (!active.signal.aborted) {
          setSyncing(false);
          const refreshAgain = queued;
          queued = false;
          if (isVisible()) {
            // Only a local commit, focus or explicit request can queue an
            // immediate scan. Slow directory reads never build up timer ticks.
            if (refreshAgain) void run();
            else timer = window.setTimeout(refresh, nextDelay);
          }
        }
      }
    }
    const refresh = () => { void run(); };
    const visibilityChanged = () => {
      if (isVisible()) refresh();
      else window.clearTimeout(timer);
    };
    check.current = run;
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', visibilityChanged);
    void run(true);
    return () => {
      active.abort();
      check.current = null;
      controller.current = null;
      window.clearTimeout(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', visibilityChanged);
    };
  }, [directory]);

  useLayoutEffect(() => {
    check.current?.();
  }, [data]);

  async function connect() {
    if (!meeting || picking) return;
    const started = lifetime.current;
    setPicking(true);
    setReport(null);
    try {
      const selected = await pickWritableDirectory('gonglun-meeting');
      if (started === lifetime.current) setConnection({ meeting, directory: selected });
    } catch (error) {
      if (started === lifetime.current && errorName(error) !== 'AbortError') {
        setReport({ message: errorMessage(error), failed: true });
      }
    } finally {
      if (started === lifetime.current) setPicking(false);
    }
  }
  function disconnect() {
    controller.current?.abort();
    setConnection(null);
    setSyncing(false);
    setReport(null);
  }
  async function syncNow() {
    const active = controller.current;
    const handle = directory as (FileSystemDirectoryHandle & {
      requestPermission?(options: { mode: 'readwrite' }): Promise<PermissionState>;
    }) | null;
    if (!active || !handle) return;
    try {
      if (handle.requestPermission && await handle.requestPermission({ mode: 'readwrite' }) !== 'granted') {
        throw new Error('尚未获得共享文件夹的读写权限。请授权后重试。');
      }
      if (!active.signal.aborted) check.current?.(true);
    } catch (error) {
      if (!active.signal.aborted) setReport({ message: errorMessage(error), failed: true });
    }
  }
  return { directory, picking, syncing, report, connect, disconnect, syncNow };
}
