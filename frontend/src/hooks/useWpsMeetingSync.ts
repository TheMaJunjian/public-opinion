import { useLayoutEffect, useRef, useState } from 'react';
import type { ExportData } from '../api/client';
import { getExportCacheReference } from '../utils/exportViewerCache';
import { exportMeetingDelta, importMeetingDelta, type MeetingEditConfirmation } from '../utils/meetingExchange';
import { publishCloudMeetingDelta } from '../utils/publishCloudMeetingDelta';
import { openWpsMeetingTransport, type WpsMeetingCheckpoint, type WpsMeetingDelta, type WpsMeetingTransport } from '../utils/wpsMeetingTransport';

import { bindLegacyWpsArchive, configuredWpsMeetingUrl, WPS_MEETING_SESSION_KEY } from '../utils/cloudMeetingAccount';
export { WPS_MEETING_SESSION_KEY };
type Status = { message: string; failed: boolean };
type Save = (next: ExportData, expected: ExportData) => Promise<void>;
type Writer = (delta: WpsMeetingDelta) => Promise<MeetingEditConfirmation>;
type Progress = { checkpoint: WpsMeetingCheckpoint; ids: string[] };
const activeWriters = new Map<string, Writer>();
const connecting = { message: '正在连接 WPS 会议…', failed: false };

function bindingKey(meeting: NonNullable<ExportData['meeting']>, url: string) {
  return JSON.stringify([meeting.id, meeting.baseHash, url]);
}

/** A cloud edit must be acknowledged before LocalDiscussion completes its local commit. */
export async function confirmWpsMeetingEdit(candidate: ExportData, expected: ExportData): Promise<MeetingEditConfirmation | false> {
  const url = configuredWpsMeetingUrl(expected.meeting, getExportCacheReference(expected));
  if (url === undefined || !expected.meeting) return false;
  const write = activeWriters.get(bindingKey(expected.meeting, url));
  if (!write) throw new Error('WPS 会议尚未连接，请稍后重新发送。');
  const delta = await exportMeetingDelta(candidate);
  if (delta.meetingId !== expected.meeting.id || delta.baseHash !== expected.meeting.baseHash) throw new Error('已切换会议，请在当前会议重新发送。');
  const previous = new Set(expected.messages.map(message => message.id));
  const entries = delta.entries.filter(entry => !previous.has(entry.id));
  if (!entries.length) return false;
  return write({ ...delta, entries });
}

function loadProgress(key: string, data: ExportData): Progress | undefined {
  try {
    const stored = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Progress | null;
    const localIds = new Set(data.messages.map(message => message.id));
    if (stored?.checkpoint && Array.isArray(stored.ids) && stored.ids.every(id => localIds.has(id))) return stored;
  } catch { /* A missing or invalid local checkpoint can always be replayed. */ }
}

export function useWpsMeetingSync(data: ExportData, onSave: Save): Status | null {
  const url = configuredWpsMeetingUrl(data.meeting, getExportCacheReference(data));
  const meetingId = data.meeting?.id, baseHash = data.meeting?.baseHash;
  const latest = useRef({ data, onSave });
  const [report, setReport] = useState<Status | null>(null);
  useLayoutEffect(() => {
    latest.current = { data, onSave };
    if (url) bindLegacyWpsArchive(data.meeting, getExportCacheReference(data));
  }, [data, onSave, url]);
  useLayoutEffect(() => {
    if (url === undefined || !meetingId || !baseHash) { setReport(null); return; }
    const controller = new AbortController();
    const { signal } = controller;
    const mount = document.createElement('div');
    mount.hidden = true;
    mount.inert = true;
    document.body.appendChild(mount);
    const options = { url, mount, meetingId, baseHash, signal };
    const key = bindingKey(latest.current.data.meeting!, url);
    const progressKey = WPS_MEETING_SESSION_KEY + ':read:' + key;
    const saved = loadProgress(progressKey, latest.current.data);
    const ids = new Set(saved?.ids);
    let checkpoint = saved?.checkpoint;
    let opening: Promise<WpsMeetingTransport> | undefined;
    let transport: WpsMeetingTransport | undefined;
    let reading = false, queued = false;
    let timer: number | undefined;
    let serial = Promise.resolve();
    function withTransport<T>(work: (connection: WpsMeetingTransport) => Promise<T>): Promise<T> {
      const result = serial.then(async () => {
        signal.throwIfAborted();
        opening ??= openWpsMeetingTransport(options)
          .then(connection => {
            if (signal.aborted) { connection.close(); signal.throwIfAborted(); }
            transport = connection;
            return connection;
          }).catch(error => { opening = undefined; throw error; });
        const connection = await opening;
        signal.throwIfAborted();
        return work(connection);
      });
      serial = result.then(() => {}, () => {});
      return result;
    }
    function status(message: string, failed = false) {
      if (!signal.aborted) setReport(previous => previous?.message === message && previous.failed === failed ? previous : { message, failed });
    }
    async function pull() {
      if (signal.aborted) return;
      window.clearTimeout(timer);
      if (reading) { queued = true; return; }
      reading = true;
      let delay = 2000;
      try {
        const result = await withTransport(async connection => {
          const entries: WpsMeetingDelta['entries'] = [];
          let cursor = checkpoint;
          for (;;) {
            const page = await connection.readSince(cursor, signal);
            if (page.reset) entries.length = 0;
            for (const batch of page.batches) for (const entry of batch.delta.entries) entries.push(entry);
            if (!page.hasMore) return { entries, progress: page.checkpoint };
            cursor = page.checkpoint;
          }
        });
        signal.throwIfAborted();
        if (result.entries.length) {
          const source = latest.current;
          const incoming = { format: 'gonglun-meeting-delta', version: 1, meetingId, baseHash, entries: result.entries };
          const merged = await importMeetingDelta(source.data, incoming);
          signal.throwIfAborted();
          if (merged.added) await source.onSave(merged.data, source.data);
          signal.throwIfAborted();
          for (const entry of result.entries) ids.add(entry.id);
        }
        if (result.entries.length || JSON.stringify(checkpoint) !== JSON.stringify(result.progress)) {
          checkpoint = result.progress;
          try { sessionStorage.setItem(progressKey, JSON.stringify({ checkpoint, ids: [...ids] })); }
          catch { /* Storage quota only costs a replay on reopen. */ }
        }
        status('WPS 会议已连接');
      } catch (error) {
        delay = 5000;
        status(error instanceof Error ? error.message : '无法读取 WPS 会议。', true);
      } finally {
        reading = false;
        if (!signal.aborted) {
          timer = window.setTimeout(pull, queued ? 0 : delay);
          queued = false;
        }
      }
    }
    const write: Writer = async delta => {
      try {
        const receipt = await withTransport(async connection => {
          if (!navigator.onLine) throw new Error('当前设备已离线，请联网后重新发送。');
          connection.assertWritable();
          const result = await publishCloudMeetingDelta(delta, {
            provider: 'WPS', archiveKey: key, signal,
            readForRetry: prior => connection.readForRetry(prior, signal),
            append: batch => connection.append(batch, signal),
          });
          if (!navigator.onLine) throw new Error('连接已中断，请恢复网络并核对会议记录。');
          return result;
        });
        signal.throwIfAborted();
        return receipt;
      } catch (error) {
        status(error instanceof Error ? error.message : 'WPS 未确认此次发言。', true);
        throw error;
      }
    };
    activeWriters.set(key, write);
    setReport(connecting);
    window.addEventListener('focus', pull);
    window.addEventListener('online', pull);
    void pull();
    return () => {
      if (activeWriters.get(key) === write) activeWriters.delete(key);
      controller.abort();
      window.clearTimeout(timer);
      window.removeEventListener('focus', pull);
      window.removeEventListener('online', pull);
      transport?.close();
      mount.remove();
    };
  }, [url, meetingId, baseHash]);
  return url === undefined ? null : report ?? connecting;
}
