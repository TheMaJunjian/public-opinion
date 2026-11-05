import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('./zhihu-view-qa.mjs', import.meta.url));

test('QA help describes its Gonglun development dependencies and current location', () => {
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /scripts\/zhihu-view-qa\.mjs/);
  assert.match(result.stdout, /frontend 源码/);
  assert.doesNotMatch(result.stdout, /tools\/zhihu-exporter/);
});

test('QA resolves the local viewer from any working directory and leaves the input unchanged', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gonglun-view-qa-test-'));
  try {
    // Empty structural data only; this is not a captured discussion sample.
    const input = JSON.stringify({
      format: 'gonglun-zhihu-crawl', status: 'complete', result: 'complete', queue: [], requestCount: 0,
      archive: {
        format: 'gonglun-zhihu-archive', version: 1,
        owner: { id: 'synthetic-owner', name: '' },
        items: [
          { id: '1', type: 'article', text: '', title: '', author: { id: 'synthetic-owner', name: '' }, completeness: { body: 'complete', comments: 'complete' } },
          { id: '1', type: 'answer', text: '', question: { id: 'q', title: '', text: '' } },
          { id: '3', type: 'pin', text: '' },
        ],
        comments: [
          { id: '2', sourceId: '2', threadId: 'article:1', text: '', rootCommentId: '2', parentCommentId: null, completeness: { body: 'complete' } },
          { id: '4', sourceId: '4', threadId: 'answer:1', text: '', rootCommentId: '4', parentCommentId: null },
          { id: '5', sourceId: '5', threadId: '3', text: '', rootCommentId: '5', parentCommentId: null },
        ],
      },
    });
    const path = join(directory, 'structural-checkpoint.json');
    await writeFile(path, input);
    const result = spawnSync(process.execPath, [script, path, '--from-checkpoint'], {
      cwd: directory, encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.checks.sourceArchiveUnchanged, true);
    assert.equal(report.checks.roundtripLocalHistory, true);
    assert.equal(report.checks.articleDiscussionsBelongToArticles, true);
    assert.equal(report.checks.articlesAndCommentsBelongToDiscussion, true);
    assert.equal(report.checks.answersAndCommentsBelongToQuestion, true);
    assert.equal(report.counts.items, 3);
    assert.equal(report.counts.comments, 3);
    assert.equal(report.counts.typeCategories, 3);
    assert.equal(await readFile(path, 'utf8'), input);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
