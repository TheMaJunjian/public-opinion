import type { ExportData } from '../api/client';
import { emptyMeetingIdentity, MAX_MEETING_BYTES } from './meetingExchange';
import { openWpsMeetingView, sdkResult, selectColumn, WpsAccessRequired, wpsAccessDenied, wpsAssetUrl, wpsSdkUrl, type WpsMeetingSdk } from './wpsMeetingTransport';

type ActiveView = Awaited<ReturnType<typeof openWpsMeetingView>>;
type Meeting = NonNullable<ExportData['meeting']>;
type ProbeWindow = Window & { loadWpsSdk?: (url: string) => Promise<WpsMeetingSdk> };

/** Match the ID used by earlier empty-table clients until the first append puts it in the cloud. */
async function meetingForEmptyTable(link: URL) {
  const identity = new URL(link.href);
  identity.searchParams.delete('readonly');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('gonglun-wps-empty-table-v1:' + identity.href));
  const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  return emptyMeetingIdentity(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`);
}

async function identifyMeeting({ view, count, viewId }: ActiveView, link: URL, signal: AbortSignal): Promise<Meeting> {
  // WPS has already granted read access to this view. Previously identified tables can resume
  // from the workbench checkpoint without downloading their historical records on every switch.
  const cacheKey = 'gonglun:wps-identity:v1:' + JSON.stringify([link.href, viewId]);
  let cached: string | null = null;
  try { cached = localStorage.getItem(cacheKey); } catch { /* Optional local cache. */ }
  if (cached) {
    try { return await emptyMeetingIdentity(cached); } catch { /* Rediscover an invalid entry. */ }
  }
  let meeting: Meeting | undefined;
  for (let start = 1; start <= count; start += 64) {
    const rows = Array.from({ length: Math.min(64, count - start + 1) }, (_, i) => start + i);
    const values = selectColumn(await sdkResult(view.RecordRange(rows, [1]).Value, signal), rows.length);
    for (const value of values) {
      if (typeof value !== 'string' || value.length > MAX_MEETING_BYTES || !value.trimStart().startsWith('{')) continue;
      let record;
      try { record = JSON.parse(value); } catch { continue; }
      if (record?.format !== 'gonglun-meeting-delta') continue;
      if (record.version !== 1 || typeof record.meetingId !== 'string' || !Array.isArray(record.entries)) {
        throw new Error('此表含有无法识别的公论会议记录。');
      }
      if (meeting && meeting.id !== record.meetingId) throw new Error('此表含有多场公论会议，请使用一场会议一份表。');
      meeting ??= await emptyMeetingIdentity(record.meetingId);
      if (meeting.baseHash !== record.baseHash) throw new Error('此会议需要原起始文件，无法仅凭云表恢复。');
    }
  }
  signal.throwIfAborted();
  if (!meeting) return meetingForEmptyTable(link);
  try { localStorage.setItem(cacheKey, meeting.id); } catch { /* Optional local cache. */ }
  return meeting;
}

export async function readWpsMeetingDocument(link: URL, signal: AbortSignal): Promise<ExportData> {
  signal.throwIfAborted();
  // The SDK only supports one config() per window. Checking a new link in an isolated
  // window keeps the current discussion connected if WPS denies the requested document.
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.inert = true;
  frame.title = '检查 WPS 云文档访问权限';
  try {
    const loaded = new Promise<void>((resolve, reject) => {
      frame.onload = () => resolve();
      frame.onerror = () => reject(new Error('无法加载 WPS 连接检查页面。'));
    });
    frame.src = wpsAssetUrl('./wps-chooser-probe.html');
    document.body.appendChild(frame);
    await sdkResult(loaded, signal);
    const probe = frame.contentWindow as ProbeWindow | null;
    const mount = frame.contentDocument?.body;
    if (!probe?.loadWpsSdk || !mount) throw new Error('无法加载 WPS 连接检查页面。');
    const sdk = await sdkResult(probe.loadWpsSdk(wpsSdkUrl()), signal);
    const active = await openWpsMeetingView({ url: link.href, sdk, mount, signal });
    try {
      const meeting = await identifyMeeting(active, link, signal);
      signal.throwIfAborted();
      return { format: 'gonglun-view-3', formatVersion: 5, exportedAt: new Date().toISOString(),
        scope: { messageId: null, title: 'WPS 云文档 · ' + link.pathname.split('/').pop() },
        messages: [], relations: [], users: [], meeting };
    } catch (error) {
      signal.throwIfAborted();
      if (wpsAccessDenied(error)) throw new WpsAccessRequired('WPS 拒绝了文档读取请求，请返回 WPS 确认访问权限。');
      throw error;
    } finally { active.instance.destroy(); }
  } finally { frame.remove(); }
}
