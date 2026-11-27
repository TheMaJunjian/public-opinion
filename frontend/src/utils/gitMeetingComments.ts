import type { ExportData } from '../api/client';
import { emptyMeetingIdentity, MAX_MEETING_BYTES, parseEntry } from './meetingExchange';
import { GitHubRequestError, githubRepositoryUrl, type GitMeetingDelta } from './gitMeetingTransport';

export type GitMeetingCommentSource = { repository: string; issue: number };
export type GitMeetingCommentRoom = { id: string; baseHash: string; title: string; createdAt: string; path: string };
type Meeting = Pick<GitMeetingCommentRoom, 'id' | 'baseHash'>;
type Scope = { source: string; meetingId: string };
type RestPage = { page: number; since: string | null };
type Watermark = { time: string | null; ids: number[] };
export type GitMeetingCommentCursor = Scope & (
  | { mode: 'graphql'; after: string | null; time?: string | null; ids?: number[] }
  | { mode: 'rest'; time: string | null; ids: number[]; after?: string | null; next?: RestPage }
);
type Saved = Scope & Watermark & { mode: 'rest' | 'graphql'; after: string | null; next?: RestPage };
type Page = { checkpoint: GitMeetingCommentCursor; hasMore: boolean };

const issueMarker = '<!-- gonglun-git-discussion-v1 -->\n';
const commentMarker = '<!-- gonglun-git-entries-v1 -->\n';
const associations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const validDate = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const utf8 = new TextEncoder();
const gitHubGraphQL = 'https://api.github.com/graphql';
const query = `query GonglunNewComments($owner: String!, $repo: String!, $issue: Int!, $after: String, $read: Boolean!, $tail: Boolean!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $issue) {
      comments(first: 100, after: $after) @include(if: $read) {
        nodes { body authorAssociation lastEditedAt createdAt fullDatabaseId }
        pageInfo { hasNextPage endCursor }
      }
      tail: comments(last: 1) @include(if: $tail) {
        nodes { createdAt fullDatabaseId }
        pageInfo { endCursor }
      }
    }
  }
}`;

export function gitMeetingCommentSource(issueUrl: string): GitMeetingCommentSource {
  let url: URL;
  try { url = new URL(issueUrl.trim()); } catch { throw new Error('请输入完整的 GitHub Issue 讨论链接。'); }
  const match = /^\/([\w-]+)\/([\w.-]+)\/issues\/([1-9]\d*)\/?$/.exec(url.pathname);
  if (url.origin !== 'https://github.com' || url.username || url.password || !match || !isNumber(Number(match[3]))) {
    throw new Error('请使用形如 https://github.com/组织名/仓库名/issues/1 的讨论链接。');
  }
  return { repository: githubRepositoryUrl(match[1] + '/' + match[2]), issue: Number(match[3]) };
}

export function gitMeetingIssueUrl(source: GitMeetingCommentSource) {
  if (!isNumber(source.issue)) throw new Error('GitHub 讨论编号无效。');
  return githubRepositoryUrl(source.repository) + '/issues/' + source.issue;
}

function apiUrl(repository: string) {
  return 'https://api.github.com/repos' + new URL(githubRepositoryUrl(repository)).pathname;
}

async function request(url: string, token: string, signal: AbortSignal, body?: unknown) {
  signal.throwIfAborted();
  const headers = new Headers({ Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10' });
  if (token.trim()) headers.set('Authorization', 'Bearer ' + token.trim());
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', headers, signal,
    credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer',
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const error = await GitHubRequestError.from(response);
    if (!error.retryAt && response.status === 403) error.message = 'GitHub 拒绝访问。请检查账号的仓库权限及 Issues 读写权限。';
    if (response.status === 404 || response.status === 410) error.message = '找不到 GitHub 讨论，请检查链接、仓库访问权限及 Issues 设置。';
    throw error;
  }
  return response;
}

function markedJson(body: unknown, marker: string): unknown {
  if (typeof body !== 'string') return undefined;
  const text = body.replace('\r\n', '\n');
  if (!text.startsWith(marker)) return undefined;
  try { return JSON.parse(text.slice(marker.length)); } catch { return undefined; }
}

async function parseRoom(issue: Record<string, unknown>, number: number): Promise<GitMeetingCommentRoom> {
  if (issue.number !== number || 'pull_request' in issue || !associations.has(String(issue.author_association))) {
    throw new Error('请选择由仓库所有者、组织成员或协作者在公论中创建的 GitHub Issue。');
  }
  const data = markedJson(issue.body, issueMarker);
  if (!isObject(data) || typeof data.meetingId !== 'string' || !uuid.test(data.meetingId) || typeof data.title !== 'string' ||
      !data.title.trim() || data.title.length > 200 || !validDate(data.createdAt) || new Date(data.createdAt).toISOString() !== data.createdAt) {
    throw new Error('此 Issue 缺少公论讨论信息，请检查链接。');
  }
  const { id, baseHash } = await emptyMeetingIdentity(data.meetingId);
  return { id, baseHash, title: data.title, createdAt: data.createdAt, path: 'gonglun/discussion-' + number + '.jsonl' };
}

export class GitIssueCreationUnconfirmed extends Error {
  constructor(readonly repository: string) {
    super('GitHub 尚未确认新建结果。请先在仓库的 Issues 中查看，若讨论已创建，复制链接即可进入。');
  }
}

export async function createGitMeetingCommentRoom(repository: string, title: string, token: string, signal: AbortSignal) {
  if (!token.trim()) throw new Error('新建讨论需要有 Issues 写权限的 GitHub 账号。');
  title = title.trim();
  if (!title || title.length > 200) throw new Error('讨论名称应为 1 至 200 个字符。');
  const data = { meetingId: crypto.randomUUID(), title, createdAt: new Date().toISOString() };
  const normalized = githubRepositoryUrl(repository);
  const body = issueMarker + JSON.stringify(data);
  let response: Response;
  try {
    response = await request(apiUrl(normalized) + '/issues', token, signal, { title, body });
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof GitHubRequestError && error.status < 500 && error.status !== 408) throw error;
    throw new GitIssueCreationUnconfirmed(normalized);
  }
  const issue = await response.json().catch(() => null);
  signal.throwIfAborted();
  if (response.status !== 201 || !isObject(issue) || !isNumber(issue.number) || typeof issue.body !== 'string' ||
    issue.body.replace('\r\n', '\n') !== body) {
    throw new GitIssueCreationUnconfirmed(normalized);
  }
  return { source: { repository: normalized, issue: issue.number }, room: await parseRoom(issue, issue.number) };
}

export function gitMeetingCommentDocument(room: GitMeetingCommentRoom): ExportData {
  return { format: 'gonglun-view-3', formatVersion: 5, scope: { messageId: null, title: room.title }, exportedAt: room.createdAt,
    meeting: { version: 1, id: room.id, baseIds: [], baseHash: room.baseHash }, messages: [], relations: [], users: [] };
}

function commentEntries(meeting: Meeting, body: unknown) {
  const data = markedJson(body, commentMarker);
  if (!isObject(data) || data.format !== 'gonglun-meeting-delta' || data.version !== 1 || data.meetingId !== meeting.id ||
    data.baseHash !== meeting.baseHash || !Array.isArray(data.entries) || !data.entries.length ||
    Object.keys(data).some(key => !['format', 'version', 'meetingId', 'baseHash', 'entries'].includes(key))) return [];
  try { return data.entries.map(parseEntry); } catch { return []; }
}

function restoreCursor(value: unknown, scope: Scope): Saved | undefined {
  if (!isObject(value) || value.source !== scope.source || value.meetingId !== scope.meetingId) return;
  if (value.mode !== 'rest' && value.mode !== 'graphql') return;
  const { after = null, time = null, ids = [], next } = value;
  if (after !== null && (typeof after !== 'string' || !after) || time !== null && !validDate(time) ||
    !Array.isArray(ids) || !ids.every(isNumber)) return;
  const saved: Saved = { ...scope, mode: value.mode, after, time, ids: [...ids] };
  if (next !== undefined) {
    if (value.mode !== 'rest' || !isObject(next) || !isNumber(next.page) || next.page < 2 || next.since !== null && !validDate(next.since)) return;
    saved.next = { page: next.page, since: next.since };
  }
  return saved;
}

// REST's since matches updated_at. For append-only comments created_at is a
// safe cutoff even mid-backfill, as editing an old comment cannot advance it.
function markSeen(mark: Watermark, at: string, id: number) {
  if (mark.time === null || at > mark.time) {
    mark.time = at;
    mark.ids = [];
  }
  if (mark.time === at && isNumber(id) && !mark.ids.includes(id)) mark.ids.push(id);
}

function covered(mark: Watermark, at: string, id: number) {
  return mark.time !== null && (at < mark.time || at === mark.time && mark.ids.includes(id));
}

export class GitMeetingComments {
  private readonly source: GitMeetingCommentSource;
  private readonly issueApi: string;
  private readonly token: string;
  constructor(source: GitMeetingCommentSource, token: string) {
    this.source = gitMeetingCommentSource(gitMeetingIssueUrl(source));
    this.issueApi = apiUrl(this.source.repository) + '/issues/' + this.source.issue;
    this.token = token.trim();
  }

  async open(signal: AbortSignal) {
    const issue = await (await request(this.issueApi, this.token, signal)).json();
    if (!isObject(issue)) throw new Error('GitHub 返回的讨论无效。');
    return parseRoom(issue, this.source.issue);
  }

  async append(delta: GitMeetingDelta, signal: AbortSignal) {
    if (!this.token) throw new Error('请先连接有 Issues 写权限的 GitHub 账号。');
    if (!delta.entries.length) throw new Error('本次没有需要发送的发言。');
    const body = commentMarker + JSON.stringify({ ...delta, entries: delta.entries.map(parseEntry) });
    if (Array.from(body).length > 65536) throw new Error('此条 GitHub 评论超过 65,536 个字符，请缩短正文或分开发送。');
    const response = await request(this.issueApi + '/comments', this.token, signal, { body });
    const item = await response.json();
    if (response.status !== 201 || !isObject(item) || !isNumber(item.id) || typeof item.body !== 'string' ||
      item.body.replace('\r\n', '\n') !== body) {
      throw new Error('GitHub 未确认这条发言，请同步后重试。');
    }
    if (!associations.has(String(item.author_association))) {
      throw new Error('此账号需要成为仓库协作者或所属组织成员，发言才能进入公论讨论。');
    }
  }

  async readSince(meeting: Meeting, stored: unknown, signal: AbortSignal) {
    const scope = { source: gitMeetingIssueUrl(this.source), meetingId: meeting.id };
    const previous = restoreCursor(stored, scope);
    const rows = new Map<string, GitMeetingDelta['entries'][number]>();
    let bytes = 0;
    function collect(body: unknown) {
      for (const entry of commentEntries(meeting, body)) {
        const old = rows.get(entry.id);
        const line = JSON.stringify(entry);
        if (old && JSON.stringify(old) !== line) throw new Error('同一 GitHub 发言编号对应不同内容，请检查讨论。');
        if (old) continue;
        bytes += utf8.encode(line).length + 1;
        if (bytes > MAX_MEETING_BYTES) throw new Error('此次新增讨论超过 32 MiB。');
        rows.set(entry.id, entry);
      }
    }
    const page = this.token ? await this.readGraphQL(scope, previous, collect, signal) :
      await this.readRest(scope, previous, collect, signal);
    const delta: GitMeetingDelta = { format: 'gonglun-meeting-delta', version: 1, meetingId: meeting.id,
      baseHash: meeting.baseHash, entries: [...rows.values()] };
    return { delta, ...page };
  }

  private async readGraphQL(scope: Scope, previous: Saved | undefined, collect: (body: unknown) => void,
    signal: AbortSignal): Promise<Page> {
    const [owner, repo] = new URL(this.source.repository).pathname.slice(1).split('/');
    let after = previous?.after ?? null;
    // A reader who joined anonymously has only REST's timestamp. Capture a
    // cursor at the Issue tail without downloading earlier comment bodies.
    const anchorOnly = previous?.mode === 'rest' && after === null && (previous.time !== null || !!previous.next);
    if (anchorOnly && previous.next) return this.readRest(scope, previous, collect, signal);
    const mark: Watermark = { time: previous?.time ?? null, ids: [...(previous?.ids ?? [])] };
    let canRecoverCursor = after !== null;
    for (;;) {
      const tail = anchorOnly || (after !== null && !mark.time);
      const response = await request(gitHubGraphQL, this.token, signal, { query,
        variables: { owner, repo, issue: this.source.issue, after, read: !anchorOnly, tail } });
      const result = await response.json();
      if (Array.isArray(result?.errors) && result.errors.length) {
        if (result.errors.some((e: { type?: string }) => e?.type === 'RATE_LIMITED')) {
          throw new GitHubRequestError(403, response, true);
        }
        if (canRecoverCursor && result.errors.some((e: { message?: string }) => /cursor/i.test(e?.message ?? ''))) {
          if (previous?.time) {
            return this.readRest(scope, { ...previous, mode: 'rest', after: null }, collect, signal);
          }
          // An older checkpoint may have only an invalidated opaque cursor.
          after = null;
          canRecoverCursor = false;
          continue;
        }
        throw new Error('GitHub 未能读取讨论评论，请检查 Issue 链接和仓库权限。');
      }
      const issue = result?.data?.repository?.issue;
      const anchor = issue?.tail;
      const anchorNode = anchor?.nodes?.[0];
      const anchorCursor = anchor?.pageInfo?.endCursor;
      const anchorTime = validDate(anchorNode?.createdAt) ? new Date(anchorNode.createdAt).toISOString() : null;
      const anchorId = Number(anchorNode?.fullDatabaseId);
      if (anchorOnly) {
        if (Array.isArray(anchor?.nodes) && !anchor.nodes.length && anchorCursor === null) {
          return { checkpoint: { ...scope, mode: 'graphql', after: null, ...mark }, hasMore: false };
        }
        if (!anchorTime || !isNumber(anchorId) || typeof anchorCursor !== 'string' || !anchorCursor) {
          return this.readRest(scope, previous, collect, signal);
        }
        if (covered(mark, anchorTime, anchorId)) {
          return { checkpoint: { ...scope, mode: 'graphql', after: anchorCursor, ...mark }, hasMore: false };
        }
        const page = await this.readRest(scope, previous, collect, signal);
        if (page.checkpoint.mode === 'rest' && !page.hasMore && covered(page.checkpoint, anchorTime, anchorId)) {
          page.checkpoint = { ...page.checkpoint, mode: 'graphql', after: anchorCursor };
        }
        return page;
      }
      const comments = issue?.comments;
      if (!Array.isArray(comments?.nodes) || typeof comments.pageInfo?.hasNextPage !== 'boolean') throw new Error('GitHub 返回的评论分页无效。');
      const { endCursor, hasNextPage } = comments.pageInfo;
      if ((hasNextPage || comments.nodes.length > 0) && (typeof endCursor !== 'string' || !endCursor || endCursor === after)) {
        throw new Error('GitHub 未返回新的评论游标。');
      }
      for (const node of comments.nodes) {
        if (validDate(node?.createdAt)) markSeen(mark, new Date(node.createdAt).toISOString(), Number(node.fullDatabaseId));
        if (node?.lastEditedAt === null && associations.has(node.authorAssociation)) collect(node.body);
      }
      if (hasNextPage || comments.nodes.length > 0) after = endCursor;
      // Upgrade an older cursor even if the room is quiet. Pin both representations
      // to the same comment so a concurrent append cannot move the REST cutoff.
      if (!mark.time && anchorTime && anchorCursor === after) markSeen(mark, anchorTime, anchorId);
      return { checkpoint: { ...scope, mode: 'graphql', after, ...mark }, hasMore: hasNextPage };
    }
  }

  // Public, signed-out readers cannot use GitHub GraphQL. GitHub REST's since
  // is second-precision, so replay the boundary second and filter by comment ID.
  private async readRest(scope: Scope, previous: Saved | undefined,
    collect: (body: unknown) => void, signal: AbortSignal): Promise<Page> {
    const url = new URL(this.issueApi + '/comments');
    url.searchParams.set('per_page', '100');
    const next = previous?.next;
    const since = next ? next.since : previous?.time ? new Date(Date.parse(previous.time) - 1000).toISOString() : null;
    if (since) url.searchParams.set('since', since);
    const page = next?.page ?? 1;
    url.searchParams.set('page', String(page));
    const mark: Watermark = { time: previous?.time ?? null, ids: [...(previous?.ids ?? [])] };
    const response = await request(url.href, this.token, signal);
    const items = await response.json();
    if (!Array.isArray(items)) throw new Error('GitHub 返回的评论列表无效。');
    for (const item of items) {
      if (!isObject(item) || !isNumber(item.id) || !validDate(item.created_at)) throw new Error('GitHub 返回的评论游标无效。');
      const at = new Date(item.created_at).toISOString();
      if (!next && previous && covered(previous, at, item.id)) continue;
      markSeen(mark, at, item.id);
      if (item.created_at === item.updated_at && associations.has(String(item.author_association))) collect(item.body);
    }
    // Use only the existence of a next page; keep subsequent HTTP requests on the selected repository.
    const hasMore = /(?:^|,)\s*<[^>]+>;\s*rel="next"/.test(response.headers.get('Link') ?? '');
    const checkpoint: GitMeetingCommentCursor = { ...scope, mode: 'rest', after: previous?.after ?? null, ...mark };
    if (hasMore) checkpoint.next = { page: page + 1, since };
    return { checkpoint, hasMore };
  }
}
