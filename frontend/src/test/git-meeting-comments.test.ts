import { afterEach, expect, it, vi } from 'vitest';
import { createGitMeetingCommentRoom, GitMeetingComments, gitMeetingCommentDocument, gitMeetingCommentSource, gitMeetingIssueUrl } from '../utils/gitMeetingComments';
import { emptyMeetingIdentity, importMeetingDelta } from '../utils/meetingExchange';
import { type GitMeetingDelta } from '../utils/gitMeetingTransport';

const issueUrl = 'https://github.com/team/meetings/issues/7';
const issueApi = 'https://api.github.com/repos/team/meetings/issues/7';
const graphql = 'https://api.github.com/graphql';
const source = { repository: 'https://github.com/team/meetings', issue: 7 };
const signal = new AbortController().signal;
const meetingId = '516b8c84-22ff-404c-a49f-a946f973c0e6';
const issueMarker = '<!-- gonglun-git-discussion-v1 -->\n';
const commentMarker = '<!-- gonglun-git-entries-v1 -->\n';
const date = '2026-11-27T01:00:00.000Z';
const meta = { meetingId, title: '测试讨论', createdAt: date };
const issue = { number: 7, author_association: 'OWNER', body: issueMarker + JSON.stringify(meta) };
const basic = { speakerId: 'local:user:7242c665-9cab-405f-9958-46418537fe9e', speaker: '成员', at: date };
const first = { ...basic, type: 'text' as const, id: 'local:5532a0d8-f60b-4d39-a9b5-be1f569c8750', text: '一楼' };
const second = { ...basic, type: 'text' as const, id: 'local:9371bcae-02bf-4560-87f3-3960879f66fc', text: '雷电回复' };
const reply = { ...basic, type: 'reply' as const, id: 'local:99298933-b9f7-4279-98df-1270ad9232d3', source: second.id, targets: [first.id] };
const json = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers });

async function batch(entries: GitMeetingDelta['entries']): Promise<GitMeetingDelta> {
  const { baseHash } = await emptyMeetingIdentity(meetingId);
  return { format: 'gonglun-meeting-delta', version: 1, meetingId, baseHash, entries };
}

function network() {
  const mock = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', mock);
  return mock;
}

const bodyFor = (d: GitMeetingDelta) => commentMarker + JSON.stringify(d);
const graphNode = (body: string, id = 1, at = date) =>
  ({ body, authorAssociation: 'COLLABORATOR', lastEditedAt: null, createdAt: at, fullDatabaseId: String(id) });
const connection = (nodes: unknown[], endCursor: string | null, hasNextPage = false) =>
  json({ data: { repository: { issue: { comments: { nodes, pageInfo: { endCursor, hasNextPage } } } } } });
const restItem = (id: number, body: string, at = date) =>
  ({ id, body, created_at: at, updated_at: at, author_association: 'MEMBER' });
afterEach(() => vi.unstubAllGlobals());

it('creates a fresh room with only the Issue request and reconstructs the same discussion from its shared URL', async () => {
  const mock = network().mockImplementationOnce(async (_, init) => {
    const { title, body } = JSON.parse(String(init?.body));
    expect(title).toBe('测试讨论');
    return json({ ...issue, body: body.replace('\n', '\r\n') }, 201);
  });
  const made = await createGitMeetingCommentRoom('Team/Meetings', '  测试讨论  ', ' secret ', signal);
  expect(made.source).toEqual(source);
  expect(made.room.path).toBe('gonglun/discussion-7.jsonl');
  expect(mock.mock.calls[0][0]).toBe('https://api.github.com/repos/team/meetings/issues');
  expect(new Headers(mock.mock.calls[0][1]?.headers).get('Authorization')).toBe('Bearer secret');
  expect(gitMeetingCommentSource(issueUrl + '?share=1#issuecomment-123')).toEqual(source);
  expect(gitMeetingIssueUrl(source)).toBe(issueUrl);
  mock.mockResolvedValueOnce(json({ ...issue, body: JSON.parse(String(mock.mock.calls[0][1]?.body)).body }));
  const reopened = await new GitMeetingComments(source, '').open(signal);
  expect(reopened).toEqual(made.room);
  expect(gitMeetingCommentDocument(reopened)).toMatchObject({ scope: { title: meta.title }, messages: [],
    meeting: { id: reopened.id, baseHash: reopened.baseHash } });
});

it('rejects unrelated Issues, pull requests, arbitrary hosts, and invalid author associations', async () => {
  expect(() => gitMeetingCommentSource('https://github.com.evil.example/team/meetings/issues/7')).toThrow('链接');
  expect(() => new GitMeetingComments({ ...source, issue: 0 }, 'token')).toThrow('编号');
  const api = new GitMeetingComments(source, 'token');
  const mock = network().mockResolvedValueOnce(json({ ...issue, body: 'plain text' }))
    .mockResolvedValueOnce(json({ ...issue, pull_request: {} })).mockResolvedValueOnce(json({ ...issue, author_association: 'CONTRIBUTOR' }));
  await expect(api.open(signal)).rejects.toThrow('讨论信息');
  await expect(api.open(signal)).rejects.toThrow('Issue');
  await expect(api.open(signal)).rejects.toThrow('协作者');
  expect(mock.mock.calls.every(([url]) => url === issueApi)).toBe(true);
});

it('distinguishes a lost Issue creation acknowledgement from a rejected request', async () => {
  const mock = network().mockRejectedValueOnce(new TypeError('connection closed'))
    .mockResolvedValueOnce(json({}, 503))
    .mockResolvedValueOnce(new Response('{', { status: 201 }))
    .mockResolvedValueOnce(json({}, 422));
  const create = () => createGitMeetingCommentRoom(source.repository, '议题', 'token', signal);
  for (let i = 0; i < 3; i++) {
    await expect(create()).rejects.toMatchObject({ repository: source.repository, message: expect.stringContaining('查看') });
  }
  await expect(create()).rejects.toMatchObject({ status: 422 });
  expect(mock).toHaveBeenCalledTimes(4);
});

it('acknowledges one POST containing only the reply and link records, before any archive action', async () => {
  const delta = await batch([second, reply]);
  const api = new GitMeetingComments(source, 'write');
  const mock = network().mockImplementationOnce(async (url, init) => {
    expect(url).toBe(issueApi + '/comments');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
    const { body } = JSON.parse(String(init?.body));
    expect(JSON.parse(body.slice(commentMarker.length))).toEqual(delta);
    expect(body).not.toContain(first.text);
    return json({ id: 15, body: body.replace('\n', '\r\n'), author_association: 'MEMBER' }, 201);
  });
  await api.append(delta, signal);
  expect(mock).toHaveBeenCalledTimes(1);
});

it('rejects a post whose body or author association the read path will not accept', async () => {
  const api = new GitMeetingComments(source, 'write');
  const delta = await batch([first]);
  network().mockResolvedValueOnce(json({ id: 13, body: 'different', author_association: 'OWNER' }, 201))
    .mockImplementationOnce(async (_, init) => json({ id: 14, ...JSON.parse(String(init?.body)), author_association: 'NONE' }, 201))
    .mockResolvedValueOnce(json({}, 403));
  await expect(api.append(delta, signal)).rejects.toThrow('未确认');
  await expect(api.append(delta, signal)).rejects.toThrow('仓库协作者');
  await expect(api.append(delta, signal)).rejects.toThrow('Issues');
});

it('reconnects using the saved cursor, reads every new page and keeps the cursor on an empty poll', async () => {
  const api = new GitMeetingComments(source, 'token');
  const mock = network().mockResolvedValueOnce(json(issue))
    .mockResolvedValueOnce(connection([graphNode(bodyFor(await batch([first])))], 'old'));
  const room = await api.open(signal);
  const start = await api.readSince(room, undefined, signal);
  const local = await importMeetingDelta(gitMeetingCommentDocument(room), start.delta);
  const mobile = new GitMeetingComments(source, 'phone-token');
  const newBody = bodyFor(await batch([second, reply]));
  mock.mockResolvedValueOnce(connection([graphNode(newBody)], 'new', true))
    .mockResolvedValueOnce(connection([graphNode(newBody)], 'retry'))
    .mockResolvedValueOnce(connection([], null));
  const change = await mobile.readSince(room, JSON.parse(JSON.stringify(start.checkpoint)), signal);
  expect(change.delta.entries.map(e => e.id)).toEqual([second.id, reply.id]);
  expect(change.hasMore).toBe(true);
  const result = await importMeetingDelta(local.data, change.delta);
  expect(result.added).toBe(2);
  expect(result.data.relations[0]).toMatchObject({ sourceMessageId: second.id });
  const retry = await mobile.readSince(room, change.checkpoint, signal);
  expect(retry.hasMore).toBe(false);
  expect((await importMeetingDelta(result.data, retry.delta)).added).toBe(0);
  const empty = await mobile.readSince(room, retry.checkpoint, signal);
  expect(empty.checkpoint).toEqual(retry.checkpoint);
  expect(empty.delta.entries).toEqual([]);
  expect(mock.mock.calls.slice(1).map(([url, init]) => {
    expect(url).toBe(graphql);
    return JSON.parse(String(init?.body)).variables.after;
  })).toEqual([null, 'old', 'new', 'retry']);
});

it('ignores hand-written, malformed, edited, outsider and wrong-room comments without losing subsequent valid messages', async () => {
  const delta = await batch([first]);
  const good = graphNode(bodyFor(delta));
  network().mockResolvedValueOnce(connection([graphNode('普通评论'), graphNode(commentMarker + '{'),
    graphNode(bodyFor({ ...delta, meetingId: 'other' })), graphNode(bodyFor({ ...delta, entries: [{ ...first, text: '' }] })),
    { ...good, authorAssociation: 'NONE' }, { ...good, lastEditedAt: date }, good], 'end'));
  const read = await new GitMeetingComments(source, 'read').readSince({ id: meetingId, baseHash: delta.baseHash }, {}, signal);
  expect(read.delta.entries).toEqual([first]);
});

it('never uses a different room’s cursor and can recover an invalidated cursor once', async () => {
  const api = new GitMeetingComments(source, 'read');
  const meeting = await emptyMeetingIdentity(meetingId);
  const cursor = { mode: 'graphql', after: 'old', meetingId, source: issueUrl };
  const mock = network().mockResolvedValueOnce(connection([], null)).mockResolvedValueOnce(json({ errors: [{ message: 'Invalid cursor' }] }))
    .mockResolvedValueOnce(connection([], null));
  await api.readSince(meeting, { ...cursor, source: issueUrl + '3' }, signal);
  await api.readSince(meeting, cursor, signal);
  expect(mock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).variables.after)).toEqual([null, 'old', null]);
});

it('preserves a rate-limit retry time, rejects partial pages and reports changed immutable record IDs', async () => {
  const meeting = await emptyMeetingIdentity(meetingId);
  network().mockResolvedValueOnce(json({ errors: [{ type: 'RATE_LIMITED' }], data: {} }))
    .mockResolvedValueOnce(connection([], null, true))
    .mockResolvedValueOnce(connection([graphNode(bodyFor(await batch([first, { ...first, text: '冲突' }])))], 'end'));
  const api = new GitMeetingComments(source, 'token');
  await expect(api.readSince(meeting, undefined, signal)).rejects.toMatchObject({ status: 403, retryAt: expect.any(Number) });
  await expect(api.readSince(meeting, undefined, signal)).rejects.toThrow('新的评论游标');
  await expect(api.readSince(meeting, undefined, signal)).rejects.toThrow('不同内容');
});

it('uses paginated anonymous REST with a one-second overlap and disambiguates simultaneous comments by ID', async () => {
  const meeting = await emptyMeetingIdentity(meetingId);
  const a = restItem(1, bodyFor(await batch([first])));
  const b = restItem(2, bodyFor(await batch([second, reply])));
  const mock = network().mockResolvedValueOnce(json([a])).mockResolvedValueOnce(json([a], 200, { Link: '<https://untrusted.example/p>; rel="next"' }))
    .mockResolvedValueOnce(json([b]));
  const api = new GitMeetingComments(source, '');
  const old = await api.readSince(meeting, undefined, signal);
  const boundary = await api.readSince(meeting, old.checkpoint, signal);
  expect(boundary.delta.entries).toEqual([]);
  expect(boundary.hasMore).toBe(true);
  const read = await api.readSince(meeting, JSON.parse(JSON.stringify(boundary.checkpoint)), signal);
  expect(read.hasMore).toBe(false);
  expect(read.delta.entries).toEqual([second, reply]);
  expect(read.checkpoint).toMatchObject({ mode: 'rest', ids: [1, 2] });
  for (const [url, init] of mock.mock.calls.slice(1)) {
    const target = new URL(String(url));
    expect(target.origin + target.pathname).toBe(issueApi + '/comments');
    expect(target.searchParams.get('since')).toBe('2026-11-27T00:59:59.000Z');
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
  }
});

it('restores signed-in progress anonymously after a reload and keeps its GraphQL position when signing back in', async () => {
  const meeting = await emptyMeetingIdentity(meetingId);
  const oldId = 45_000_000_001, newId = oldId + 1;
  const oldBody = bodyFor(await batch([first])), newBody = bodyFor(await batch([second, reply]));
  const mock = network().mockResolvedValueOnce(connection([graphNode(oldBody, oldId)], 'signed-in'))
    .mockResolvedValueOnce(json([restItem(oldId, oldBody), restItem(newId, newBody)]))
    .mockResolvedValueOnce(connection([graphNode(newBody, newId)], 'latest'));
  const old = await new GitMeetingComments(source, 'desktop').readSince(meeting, undefined, signal);
  expect(old.checkpoint).toMatchObject({ after: 'signed-in', time: date, ids: [oldId] });
  const mobile = await new GitMeetingComments(source, '').readSince(meeting, JSON.parse(JSON.stringify(old.checkpoint)), signal);
  expect(mobile.delta.entries).toEqual([second, reply]);
  expect(mobile.checkpoint).toMatchObject({ mode: 'rest', after: 'signed-in', time: date, ids: [oldId, newId] });
  const [unsignedUrl, unsignedInit] = mock.mock.calls[1];
  expect(new URL(String(unsignedUrl)).searchParams.get('since')).toBe('2026-11-27T00:59:59.000Z');
  expect(new Headers(unsignedInit?.headers).has('Authorization')).toBe(false);
  const resumed = await new GitMeetingComments(source, 'again').readSince(meeting, mobile.checkpoint, signal);
  expect(resumed.checkpoint).toMatchObject({ mode: 'graphql', after: 'latest', ids: [oldId, newId] });
  const [signedUrl, signedInit] = mock.mock.calls[2];
  expect(signedUrl).toBe(graphql);
  expect(JSON.parse(String(signedInit?.body)).variables).toMatchObject({ after: 'signed-in', read: true, tail: false });
});

it('switches an anonymous-first reader to GraphQL without fetching history, including comments arriving during sign-in', async () => {
  const meeting = await emptyMeetingIdentity(meetingId);
  const older = bodyFor(await batch([first])), newer = bodyFor(await batch([second, reply]));
  const later = '2026-11-27T01:00:01.000Z';
  const tail = { nodes: [{ createdAt: later, fullDatabaseId: '2' }], pageInfo: { endCursor: 'anchor' } };
  const mock = network().mockResolvedValueOnce(json([restItem(1, older)]))
    .mockResolvedValueOnce(json({ data: { repository: { issue: { tail } } } }))
    .mockResolvedValueOnce(json([restItem(1, older), restItem(2, newer, later)]))
    .mockResolvedValueOnce(connection([], null));
  const old = await new GitMeetingComments(source, '').readSince(meeting, undefined, signal);
  const signed = new GitMeetingComments(source, 'token');
  const caughtUp = await signed.readSince(meeting, old.checkpoint, signal);
  expect(JSON.parse(String(mock.mock.calls[1][1]?.body)).variables).toMatchObject({ read: false, tail: true });
  expect(new URL(String(mock.mock.calls[2][0])).searchParams.get('since')).toBe('2026-11-27T00:59:59.000Z');
  expect(new Headers(mock.mock.calls[2][1]?.headers).get('Authorization')).toBe('Bearer token');
  expect(caughtUp.delta.entries).toEqual([second, reply]);
  expect(caughtUp.checkpoint).toMatchObject({ mode: 'graphql', after: 'anchor', time: later, ids: [2] });
  await signed.readSince(meeting, caughtUp.checkpoint, signal);
  expect(JSON.parse(String(mock.mock.calls[3][1]?.body)).variables).toMatchObject({ read: true, after: 'anchor' });
});

it('seeds the portable timestamp of an old signed-in checkpoint during an empty poll without downloading historical bodies', async () => {
  const meeting = await emptyMeetingIdentity(meetingId);
  const checkpoint = { mode: 'graphql', source: issueUrl, meetingId, after: 'old-graph-only' };
  const issueInfo = { comments: { nodes: [], pageInfo: { endCursor: null, hasNextPage: false } },
    tail: { nodes: [{ createdAt: date, fullDatabaseId: '99' }], pageInfo: { endCursor: 'old-graph-only' } } };
  const mock = network().mockResolvedValueOnce(json({ data: { repository: { issue: issueInfo } } }));
  const result = await new GitMeetingComments(source, 'token').readSince(meeting, checkpoint, signal);
  expect(result.delta.entries).toEqual([]);
  expect(result.checkpoint).toMatchObject({ ...checkpoint, time: date, ids: [99] });
  expect(JSON.parse(String(mock.mock.calls[0][1]?.body)).variables).toMatchObject({ read: true, after: 'old-graph-only', tail: true });
});

it('continues from the portable watermark if GitHub invalidates a cursor while signed out', async () => {
  const meeting = await emptyMeetingIdentity(meetingId);
  const checkpoint = { mode: 'rest', source: issueUrl, meetingId, after: 'expired', time: date, ids: [1] };
  const newer = bodyFor(await batch([second, reply]));
  const mock = network().mockResolvedValueOnce(json({ errors: [{ message: 'Invalid cursor' }] }))
    .mockResolvedValueOnce(json([restItem(2, newer)]));
  const read = await new GitMeetingComments(source, 'again').readSince(meeting, checkpoint, signal);
  expect(read.delta.entries).toEqual([second, reply]);
  expect(read.checkpoint).toMatchObject({ mode: 'rest', after: null, ids: [1, 2] });
  expect(new URL(String(mock.mock.calls[1][0])).searchParams.get('since')).toBe('2026-11-27T00:59:59.000Z');
});
