import { MAX_MEETING_BYTES, type exportMeetingDelta } from './meetingExchange';

export type WpsMeetingDelta = Awaited<ReturnType<typeof exportMeetingDelta>>;
type MaybePromise<T> = T | PromiseLike<T>;
type WpsRange = { Value: unknown };
export type WpsView = {
  Id: MaybePromise<string>;
  Records: { Item(row: number): { Id: MaybePromise<string> } };
  RecordRange: {
    (rows: number[], fields: number[]): WpsRange;
    Count: MaybePromise<number>;
    Add(before: null, after: number | null, count: number): MaybePromise<WpsRange>;
  };
};
type WpsInstance = {
  ready(): Promise<unknown>;
  destroy(): void;
  Application: { ActiveView: MaybePromise<WpsView> };
};
export type WpsMeetingSdk = {
  config(options: { officeType: 'd'; url: string; mount: HTMLElement }): WpsInstance;
};
type OpenOptions = {
  url: string; mount: HTMLElement; meetingId: string; baseHash: string;
  sdk?: WpsMeetingSdk; sdkUrl?: string; signal?: AbortSignal;
};
type PendingRow = { row: number; attempts: number; retryAt: number };
export type WpsMeetingCheckpoint = {
  source: string; cursor: number; anchor: string | null; pendingRows: PendingRow[];
};
export type WpsMeetingRead = {
  batches: { row: number; delta: WpsMeetingDelta }[];
  checkpoint: WpsMeetingCheckpoint;
  reset: boolean;
  /** More new rows to read; blank rows are retried separately. */
  hasMore: boolean;
};

const rowsPerPage = 64;
const retryDelay = (attempts: number) => Math.min(60_000, 500 * 2 ** Math.min(7, attempts - 1));

function checkedCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('WPS 未返回有效记录数。');
  return value;
}

function parseDelta(text: string, meetingId: string, baseHash: string): WpsMeetingDelta | undefined {
  if (!text.trimStart().startsWith('{') || text.length > MAX_MEETING_BYTES) return;
  let candidate: WpsMeetingDelta | null;
  try { candidate = JSON.parse(text); } catch { return; }
  if (candidate?.format === 'gonglun-meeting-delta' && candidate.version === 1 &&
      candidate.meetingId === meetingId && candidate.baseHash === baseHash && Array.isArray(candidate.entries)) {
    // importMeetingDelta validates individual entries, references and conflicts before local commit.
    return candidate;
  }
}

class WpsRequestTimeout extends Error {}
export class WpsAccessRequired extends Error {}

export function wpsAccessDenied(error: unknown): boolean {
  const { status, statusCode, code, name, message } = error && typeof error === 'object'
    ? error as Record<string, unknown> : { code: error };
  if ([status, statusCode, code].some(value => String(value) === '401' || String(value) === '403')) return true;
  return [name, code, message].some(value => typeof value === 'string' &&
    /unauthenticated|unauthorized|forbidden|access[ _-]?denied|permission[ _-]?denied|not[ _-]?logged[ _-]?in|请先登录|未登录|没有访问权限|无权访问|权限不足/i.test(value));
}

export function sdkResult<T>(operation: MaybePromise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const clear = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    const fail = (error: unknown) => { clear(); reject(error); };
    const onAbort = () => fail(signal?.reason);
    const timer = setTimeout(() => fail(new WpsRequestTimeout('WPS 请求超时，请检查文档访问权限后重试。')), 20_000);
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(value => { clear(); resolve(value); }, fail);
  });
}

export function selectColumn(value: unknown, expected: number): unknown[] {
  const rows = Array.isArray(value) ? value : [value];
  if (rows.length !== expected) throw new Error('WPS 返回的行数与请求不符，将重新读取。');
  return rows.map(row => Array.isArray(row) ? row[0] : row);
}

function validCheckpoint(checkpoint: WpsMeetingCheckpoint, source: string, count: number) {
  return checkpoint.source === source && Number.isSafeInteger(checkpoint.cursor) && checkpoint.cursor >= 0 &&
    checkpoint.cursor <= count && (checkpoint.cursor === 0 ? checkpoint.anchor === null : typeof checkpoint.anchor === 'string') &&
    Array.isArray(checkpoint.pendingRows) && checkpoint.pendingRows.every(item => item &&
      Number.isSafeInteger(item.row) && item.row >= 1 && item.row <= checkpoint.cursor &&
      Number.isSafeInteger(item.attempts) && item.attempts > 0 && Number.isFinite(item.retryAt));
}

export class WpsMeetingTransport {
  private closed = false;
  private queue: Promise<void> = Promise.resolve();
  // An uncertain write may already own a row. A retry may use only its original range.
  private readonly unfinished = new Map<string, WpsRange>();

  constructor(private readonly instance: WpsInstance, private readonly view: WpsView, private readonly source: string,
    private readonly meetingId: string, private readonly baseHash: string, private readonly readonlyLink: boolean) {}

  private active(signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (this.closed) throw new DOMException('WPS 连接已关闭。', 'AbortError');
  }

  private async rowId(row: number, signal?: AbortSignal): Promise<string> {
    const id = await sdkResult(this.view.Records.Item(row).Id, signal);
    if (typeof id !== 'string' || !id) throw new Error('WPS 未返回可确认的记录编号。');
    return id;
  }

  /** The dedicated sheet uses its first text column and an unsorted, append-only view.
   * The caller commits the returned checkpoint only after committing received deltas locally. */
  async readSince(previous?: WpsMeetingCheckpoint, signal?: AbortSignal): Promise<WpsMeetingRead> {
    this.active(signal);
    const count = checkedCount(await sdkResult(this.view.RecordRange.Count, signal));
    let reset = !!previous && !validCheckpoint(previous, this.source, count);
    if (previous && !reset && previous.cursor) reset = (await this.rowId(previous.cursor, signal)) !== previous.anchor;
    const saved = reset ? undefined : previous;
    const last = saved?.cursor ?? 0;
    const cursor = Math.min(count, last + rowsPerPage);
    const pending = new Map((saved?.pendingRows ?? []).map(item => [item.row, item]));
    const now = Date.now();
    const due = [...pending.values()].filter(p => p.retryAt <= now).sort((a,b) => a.retryAt - b.retryAt)
      .slice(0, rowsPerPage).map(p => p.row);
    const fresh = Array.from({ length: cursor - last }, (_, i) => last + i + 1);
    const indexes = [...due, ...fresh].sort((a,b) => a - b);
    // Two clients can both append after the same last record. Detect an insertion before our
    // checkpoint by stable WPS ID, without rereading text from a completed row on idle rounds.
    const anchor = cursor === last ? saved?.anchor ?? null : await this.rowId(cursor, signal);
    const batches: WpsMeetingRead['batches'] = [];
    for (let offset = 0; offset < indexes.length; offset += rowsPerPage) {
      this.active(signal);
      const page = indexes.slice(offset, offset + rowsPerPage);
      const values = selectColumn(await sdkResult(this.view.RecordRange(page, [1]).Value, signal), page.length);
      for (const [i, value] of values.entries()) {
        const row = page[i];
        if (value === null || value === undefined || value === '') {
          const attempts = (pending.get(row)?.attempts ?? 0) + 1;
          pending.set(row, { row, attempts, retryAt: now + retryDelay(attempts) });
        } else {
          pending.delete(row);
          const delta = typeof value === 'string' && parseDelta(value, this.meetingId, this.baseHash);
          if (delta) batches.push({ row, delta });
        }
      }
    }
    if (indexes.length && cursor && await this.rowId(cursor, signal) !== anchor) {
      throw new Error('读取时 WPS 记录顺序发生变化，请从上次进度重试。');
    }
    if (fresh.length && last && await this.rowId(last, signal) !== saved?.anchor) {
      throw new Error('并发写入改变了 WPS 末行位置，请从上次进度重试。');
    }
    this.active(signal);
    return { batches, checkpoint: { source: this.source, cursor, anchor, pendingRows: [...pending.values()] },
      reset, hasMore: count > cursor };
  }

  append(delta: WpsMeetingDelta, signal?: AbortSignal): Promise<void> {
    const write = this.queue.then(() => this.write(delta, signal));
    this.queue = write.catch(() => {});
    return write;
  }

  async readForRetry(delta: WpsMeetingDelta, signal?: AbortSignal): Promise<WpsMeetingDelta['entries']> {
    this.active(signal);
    const text = JSON.stringify(delta);
    const range = this.unfinished.get(text);
    if (range) {
      const [existing] = selectColumn(await sdkResult(range.Value, signal), 1);
      if (existing === text) {
        this.unfinished.delete(text);
        return delta.entries;
      }
      if (existing === null || existing === undefined || existing === '') return [];
      throw new Error('先前新增的 WPS 行包含其他内容，请核对该行。');
    }
    // Reopening loses the SDK range but keeps the tab's pending edit. Check the table
    // independently of the viewer checkpoint, which may already have advanced past it.
    const wanted = new Set(delta.entries.map(entry => entry.id));
    const found: WpsMeetingDelta['entries'] = [];
    let cursor: WpsMeetingCheckpoint | undefined;
    for (;;) {
      const page = await this.readSince(cursor, signal);
      if (page.reset) found.length = 0;
      for (const { delta: batch } of page.batches) {
        for (const entry of batch.entries) if (wanted.has(entry.id)) found.push(entry);
      }
      if (!page.hasMore) return found;
      cursor = page.checkpoint;
    }
  }

  assertWritable() {
    if (this.readonlyLink) throw new Error('该 WPS 链接为只读。');
  }

  private async write(delta: WpsMeetingDelta, signal?: AbortSignal) {
    this.active(signal);
    this.assertWritable();
    if (delta.format !== 'gonglun-meeting-delta' || delta.version !== 1 ||
        delta.meetingId !== this.meetingId || delta.baseHash !== this.baseHash) throw new Error('WPS 连接属于另一场会议。');
    if (!delta.entries.length) return;
    const text = JSON.stringify(delta);
    if (new Blob([text]).size > MAX_MEETING_BYTES) throw new Error('会议批次超过 32 MiB。');
    let range = this.unfinished.get(text);
    if (range) {
      const [existing] = selectColumn(await sdkResult(range.Value, signal), 1);
      if (existing === text) { this.unfinished.delete(text); return; }
      if (existing !== null && existing !== undefined && existing !== '') {
        throw new Error('先前新增的 WPS 行包含其他内容，请核对该行。');
      }
    } else {
      const count = checkedCount(await sdkResult(this.view.RecordRange.Count, signal));
      this.active(signal);
      range = await sdkResult(this.view.RecordRange.Add(null, count || null, 1), signal);
      this.unfinished.set(text, range);
    }
    this.active(signal);
    range.Value = [[text]];
    // The SDK property setter is asynchronous. Confirm its own new row, never count+1.
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, attempt * 200));
      this.active(signal);
      const [actual] = selectColumn(await sdkResult(range.Value, signal), 1);
      if (actual === text) { this.unfinished.delete(text); return; }
      if (actual !== null && actual !== undefined && actual !== '') throw new Error('WPS 返回的批次内容不一致。');
    }
    throw new Error('WPS 尚未确认批次写入，请同步后重试。');
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.unfinished.clear();
    this.instance.destroy();
  }
}

export function wpsDocumentUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('请粘贴 WPS 多维表格的完整分享链接。'); }
  if (url.protocol !== 'https:' || !['365.kdocs.cn', 'kdocs.cn', 'www.kdocs.cn'].includes(url.hostname) ||
      url.port || url.username || url.password || !/^\/l\/[A-Za-z0-9]+\/?$/.test(url.pathname)) {
    throw new Error('请提供 WPS 多维表格的 HTTPS 分享链接。');
  }
  const host = url.hostname === 'kdocs.cn' ? 'www.kdocs.cn' : url.hostname;
  const normalized = new URL(url.pathname.replace(/\/$/, ''), 'https://' + host);
  if (url.searchParams.has('sheet')) normalized.searchParams.set('sheet', url.searchParams.get('sheet')!);
  if (url.searchParams.has('readonly')) normalized.searchParams.set('readonly', '');
  return normalized;
}

/** WPS copies a document title and a link together. Chat apps may escape the URL as Markdown. */
export function wpsUrlFromShareText(input: string): URL {
  const text = input.replace(/\\([:/.\-?&#=])/g, '$1');
  const candidates = text.match(/https?:\/\/[^\s<>"'“”‘’「」『』【】《》()\x5b\x5d（）\x60，。；！？、]+/gi) ?? [];
  const documents = new Map<string, URL>();
  for (const candidate of candidates) {
    let url: URL;
    try {
      // A trailing period can belong to a query value. Only strip prose punctuation from bare short links.
      url = wpsDocumentUrl(/[?#]/.test(candidate) ? candidate : candidate.replace(/[.,;!]+$/, ''));
    } catch {
      continue;
    }
    documents.set(url.href, url);
  }
  if (documents.size > 1) throw new Error('检测到多个 WPS 云文档链接，请只保留要打开的一个。');
  const [document] = documents.values();
  if (!document) throw new Error('未找到 WPS 多维表格分享链接，请粘贴完整链接或分享文字。');
  return document;
}

export function wpsAssetUrl(path: string): string {
  // Development uses BrowserRouter (including nested /messages routes); a packaged
  // HashRouter site may instead live in a subdirectory under the current host.
  const url = new URL(path, import.meta.env.DEV ? location.origin + '/' : document.baseURI);
  if (url.origin !== location.origin) throw new Error('WPS SDK 应由当前站点提供。');
  return url.href;
}

export function wpsSdkUrl(override?: string): string {
  return wpsAssetUrl(override || import.meta.env.VITE_WPS_SDK_URL || './wps-sdk.es.js');
}

export async function openWpsMeetingView(options: Omit<OpenOptions, 'meetingId' | 'baseHash'>) {
  const { signal } = options;
  signal?.throwIfAborted();
  const url = wpsDocumentUrl(options.url);
  let sdk = options.sdk;
  if (!sdk) {
    sdk = (await import(/* @vite-ignore */ wpsSdkUrl(options.sdkUrl))).default as WpsMeetingSdk;
  }
  signal?.throwIfAborted();
  url.searchParams.set('disablePlugins','');
  url.searchParams.set('simple','1');
  let instance: WpsInstance | undefined;
  let waitingForReady = true;
  try {
    instance = sdk.config({ officeType: 'd', url: url.href, mount: options.mount });
    await sdkResult(instance.ready(), signal);
    waitingForReady = false;
    const view = await sdkResult(instance.Application.ActiveView, signal);
    const count = checkedCount(await sdkResult(view.RecordRange.Count, signal));
    const viewId = await sdkResult(view.Id, signal);
    signal?.throwIfAborted();
    return { instance, view, count, viewId, url };
  } catch (error) {
    instance?.destroy();
    signal?.throwIfAborted();
    // A private WPS sign-in/access screen never sends the SDK's ready handshake.
    if (wpsAccessDenied(error) || (waitingForReady && error instanceof WpsRequestTimeout)) {
      throw new WpsAccessRequired('WPS 未确认文档访问权限。请在 WPS 完成登录或申请权限后，返回这里重试。');
    }
    throw error;
  }
}

export async function openWpsMeetingTransport(options: OpenOptions): Promise<WpsMeetingTransport> {
  const { meetingId, baseHash } = options;
  const { instance, view, viewId, url } = await openWpsMeetingView(options);
  const source = JSON.stringify([url.hostname, url.pathname, url.searchParams.get('sheet'), viewId, meetingId, baseHash]);
  return new WpsMeetingTransport(instance, view, source, meetingId, baseHash, url.searchParams.has('readonly'));
}
