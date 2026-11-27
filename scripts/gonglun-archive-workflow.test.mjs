import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import yaml from 'js-yaml';

const execute = promisify(execFile);
const workflow = yaml.load(readFileSync(new URL('../frontend/public/gonglun-archive.yml', import.meta.url), 'utf8'));
const script = workflow.jobs.archive.steps[0].run;
const createdAt = '2026-11-27T10:00:00.000Z';
const room = () => ({ title: '讨论', meetingId: randomUUID(), createdAt });
const speaker = { speaker: '成员', speakerId: 'local:user:' + randomUUID(), at: createdAt };
const post = text => ({ id: 'local:' + randomUUID(), ...speaker, type: 'text', text });
const reply = (source, target) => ({ id: 'local:' + randomUUID(), ...speaker, type: 'reply', source: source.id, targets: [target.id] });
const file = n => 'gonglun/discussion-' + n + '.jsonl';
function comment({ meetingId }, entries, extra = {}) {
  const baseHash = createHash('sha256').update(JSON.stringify([meetingId, []])).digest('hex');
  return { authorAssociation: 'MEMBER', lastEditedAt: null, body: '<!-- gonglun-git-entries-v1 -->\n' +
    JSON.stringify({ format: 'gonglun-meeting-delta', version: 1, meetingId, baseHash, entries }), ...extra };
}

async function fixture(t, files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gonglun-archive-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const remote = join(dir, 'group', 'rooms.git');
  mkdirSync(remote, { recursive: true });
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'empty-config'),
    GIT_AUTHOR_NAME: 'test', GIT_COMMITTER_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  function git(args, input) {
    return execFileSync('git', args, { cwd: remote, env, input, encoding: 'utf8' }).trimEnd();
  }
  git(['init', '--bare', '--quiet', '--initial-branch=main', '.']);
  git(['config', 'uploadpack.allowFilter', 'true']);
  const index = Object.entries({ 'README.md': ['100644', 'Keep this file'], ...files }).map(([path, [mode, data]]) => {
    const blob = git(['hash-object', '-w', '--stdin'], data);
    return mode + ' blob ' + blob + '\t' + path + '\0';
  });
  git(['update-index', '-z', '--index-info'], index.join(''));
  git(['update-ref', 'refs/heads/main', git(['commit-tree', git(['write-tree']), '-m', 'First commit'])]);
  const source = join(dir, 'archive.cjs');
  writeFileSync(source, script);
  const issues = new Map(), queries = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { variables } = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(req.headers.authorization, 'Bearer test-fixture-only');
    assert.deepEqual([variables.owner, variables.repo], ['group', 'rooms']);
    queries.push(variables);
    const issueFixture = issues.get(variables.issue);
    const { metadata, comments, association } = issueFixture;
    if (variables.after && variables.after === issueFixture.invalidCursor) {
      delete issueFixture.invalidCursor;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ errors: [{ message: 'Invalid cursor' }] }));
    }
    const start = Number(variables.after ?? 0);
    const nodes = comments.slice(start, start + 2);
    const issue = { authorAssociation: association, body: '<!-- gonglun-git-discussion-v1 -->\n' + JSON.stringify(metadata),
      comments: { nodes, pageInfo: { hasNextPage: start + nodes.length < comments.length,
        endCursor: nodes.length ? String(start + nodes.length) : null } } };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: { repository: { issue } } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const api = 'http://127.0.0.1:' + server.address().port;
  function discussion(number) {
    const issue = { metadata: room(), comments: [], association: 'OWNER' };
    issues.set(number, issue);
    return issue;
  }
  async function run(number, eventName = 'issue_comment', ref = 'refs/heads/main') {
    const eventPath = join(dir, randomUUID() + '.json');
    writeFileSync(eventPath, JSON.stringify({ repository: { default_branch: 'main' }, issue: { number }, inputs: { issue: String(number) } }));
    return execute(process.execPath, [source], { env: { ...env, GH_TOKEN: 'test-fixture-only', RUNNER_TEMP: dir,
      GITHUB_REF: ref, GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: eventName, GITHUB_REPOSITORY: 'group/rooms',
      GITHUB_GRAPHQL_URL: api, GITHUB_SERVER_URL: pathToFileURL(dir).href } });
  }
  const archive = number => git(['cat-file', 'blob', 'main:' + file(number)]).split('\n').map(JSON.parse);
  return { git, discussion, run, archive, queries, remote };
}

test('only relevant trusted issue events schedule work; manual runs can repair one selected issue', () => {
  assert.deepEqual(workflow.permissions, { issues: 'read', contents: 'write' });
  assert.deepEqual(workflow.on.issues.types, ['opened']);
  assert.deepEqual(workflow.on.issue_comment.types, ['created']);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs), ['issue']);
  for (const field of ['pull_request', 'issue.author_association', 'comment.author_association',
    'gonglun-git-entries-v1', 'gonglun-git-discussion-v1']) assert.ok(workflow.jobs.archive.if.includes(field));
  assert.equal(workflow.jobs.archive.concurrency['cancel-in-progress'], false);
  assert.doesNotMatch(script, /\$\{\{/);
});

test('creates the one-file archive, catches up multiple pages after an outage, resumes from its cursor and replays idempotently', async t => {
  const { discussion, run, archive, git, queries } = await fixture(t);
  const issue = discussion(3);
  const { metadata, comments } = issue;
  const first = post('你好🌱'), second = post('我的回复'), link = reply(second, first);
  await run(3, 'issues');
  assert.deepEqual(archive(3), [{ format: 'gonglun-git-meeting', version: 1, id: metadata.meetingId, title: metadata.title,
    createdAt, githubIssue: 3, commentCursor: null }]);
  const submitted = comment(metadata, [first]);
  submitted.body = submitted.body.replace('\n', '\r\n');
  comments.push(submitted, comment(metadata, [post('ignore outsider')], { authorAssociation: 'CONTRIBUTOR' }),
    comment(metadata, [post('ignore edit')], { lastEditedAt: createdAt }), comment(room(), [post('unrelated meeting')]),
    comment(metadata, [{}]), comment(metadata, [second, link, first]));
  await run(3);
  assert.deepEqual(archive(3).slice(1), [first, second, link]);
  assert.equal(archive(3)[0].commentCursor, '6');
  assert.deepEqual(queries.slice(-3).map(q => q.after), [null, '2', '4']);
  const last = post('下一条');
  comments.push(comment(metadata, [last]));
  await run(3);
  assert.equal(queries.at(-1).after, '6');
  assert.deepEqual(archive(3).slice(1), [first, second, link, last]);
  const head = git(['rev-parse', 'main']);
  await run(3, 'workflow_dispatch');
  assert.equal(git(['rev-parse', 'main']), head);
  assert.equal(git(['cat-file', 'blob', 'main:README.md']), 'Keep this file');
  issue.invalidCursor = '7';
  const fresh = post('恢复后');
  comments.push(comment(metadata, [fresh]));
  await run(3);
  assert.deepEqual(archive(3).slice(1), [first, second, link, last, fresh]);
});

test('overlapping archives from two rooms preserve both on the shared default branch', async t => {
  const { discussion, run, archive, remote } = await fixture(t);
  const a = discussion(4), b = discussion(5);
  const left = post('A'), right = post('B');
  a.comments.push(comment(a.metadata, [left]));
  b.comments.push(comment(b.metadata, [right]));
  writeFileSync(join(remote, 'hooks', 'pre-receive'), '#!/bin/sh\nsleep 1\n', { mode: 0o755 });
  await Promise.all([run(4), run(5)]);
  assert.deepEqual(archive(4).slice(1), [left]);
  assert.deepEqual(archive(5).slice(1), [right]);
});

test('refuses conflicting payloads and protects unrelated regular files, symlinks and refs', async t => {
  const damaged = { format: 'gonglun-git-meeting', version: 1, githubIssue: 8, commentCursor: null };
  const { discussion, run, git } = await fixture(t, { [file(5)]: ['100644', 'private unrelated data\n'], [file(6)]: ['120000', '../README.md'],
    [file(8)]: ['100644', JSON.stringify(damaged) + '\n\n'] });
  const first = post('first');
  const issue = discussion(4);
  issue.comments.push(comment(issue.metadata, [first]));
  await run(4);
  const head = git(['rev-parse', 'main']);
  issue.comments.push(comment(issue.metadata, [{ ...first, text: 'private modified message' }]));
  discussion(5);
  discussion(6);
  discussion(7).association = 'NONE';
  discussion(8);
  await assert.rejects(run(8), /empty record/);
  const requests = [run(4), run(5), run(6), run(7), run(4, 'workflow_dispatch', 'refs/heads/other')];
  await Promise.all(requests.map(request => assert.rejects(request, error => {
    assert.doesNotMatch(error.stderr, /private/);
    return error.code === 1;
  })));
  assert.equal(git(['rev-parse', 'main']), head);
});

test('does not replace a symlink or file in the archive directory position', async t => {
  const { discussion, run, git } = await fixture(t, { gonglun: ['120000', 'other'] });
  discussion(8);
  const head = git(['rev-parse', 'main']);
  await assert.rejects(run(8), /regular directory/);
  assert.equal(git(['rev-parse', 'main']), head);
});
