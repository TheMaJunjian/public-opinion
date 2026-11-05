import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createOverrides, getRelations, applyRelation, resetRelation, materializeRelations, applyRelationBatch, undoRelationBatch } from '../utils/zhihuRelations.mjs';

// Structural fixtures only; empty comments are not real discussion corpus.
const at = '2026-11-01T01:00:00Z';
const row = (id, extra = {}) => ({ id, sourceId: id, threadId: 'answer:1', text: '', parentCommentId: null, rootCommentId: id, issues: [], ...extra });
const archive = (comments) => ({ format: 'gonglun-zhihu-archive', version: 1, comments });

test('original roots, explicit parents, unknown replies and absent parents stay distinct', () => {
  const input = archive([
    row('1'), row('2', { rootCommentId: '1', parentCommentId: '1' }),
    row('3', { rootCommentId: '1', replyToAuthor: { id: 'author' } }),
    row('4', { rootCommentId: null }), row('5', { rootCommentId: '1', parentCommentId: 'absent' }),
  ]);
  const result = getRelations(input, createOverrides());
  assert.deepEqual(result.map(value => value.source), ['original', 'original', 'unknown', 'unknown', 'original']);
  assert.deepEqual(result.map(value => value.needsReview), [false, false, true, true, true]);
  assert.equal(result[2].effectiveParentCommentId, null);
  assert.equal(result[4].effectiveParentCommentId, 'absent');
});

test('manual links and manual top level are append-only and never mutate source records', () => {
  const input = archive([row('1'), row('2', { rootCommentId: '1' })]);
  const original = structuredClone(input);
  const empty = createOverrides();
  const linked = applyRelation(input, empty, { threadId: 'answer:1', commentId: '2', parentCommentId: '1', note: '测试备注' }, at);
  const top = applyRelation(input, linked, { threadId: 'answer:1', commentId: '2', parentCommentId: null }, () => at);
  assert.deepEqual(input, original);
  assert.equal(empty.revisions.length, 0);
  assert.equal(linked.revisions.length, 1);
  assert.equal(top.revisions.length, 2);
  const relation = getRelations(input, top)[1];
  assert.equal(relation.source, 'manual');
  assert.equal(relation.needsReview, false);
  assert.equal(relation.originalParentCommentId, null);
  assert.equal(relation.effectiveParentCommentId, null);
  assert.equal(relation.revisionId, top.revisions[1].id);
});

test('reset appends history and restores unknown original relationship', () => {
  const input = archive([row('1'), row('2', { rootCommentId: '1' })]);
  const linked = applyRelation(input, createOverrides(), { threadId: 'answer:1', commentId: '2', parentCommentId: '1' }, at);
  const reset = resetRelation(input, linked, { threadId: 'answer:1', commentId: '2' }, new Date(at));
  assert.deepEqual(reset.revisions.map(value => value.action), ['set', 'reset']);
  assert.equal(getRelations(input, reset)[1].source, 'unknown');
  assert.equal(getRelations(input, reset)[1].effectiveParentCommentId, null);
  assert.equal(linked.revisions.length, 1);
});

test('cross-thread links, missing comments, self-links and direct or indirect cycles are rejected', () => {
  const input = archive([row('1'), row('2', { rootCommentId: '1', parentCommentId: '1' }), row('3', { rootCommentId: '1', parentCommentId: '2' }), row('other', { threadId: 'article:1' })]);
  const empty = createOverrides();
  const change = (commentId, parentCommentId) => applyRelation(input, empty, { threadId: 'answer:1', commentId, parentCommentId }, at);
  assert.throws(() => change('1', 'other'), /同一讨论/);
  assert.throws(() => change('missing', null), /不存在/);
  assert.throws(() => change('1', '1'), /自身/);
  assert.throws(() => change('1', '2'), /循环/);
  assert.throws(() => change('1', '3'), /循环/);
  assert.equal(empty.revisions.length, 0);
});

test('known root ancestry prevents a cycle even when the direct reply is unknown', () => {
  const input = archive([row('1'), row('2', { rootCommentId: '1', parentCommentId: null })]);
  assert.throws(() => applyRelation(input, createOverrides(), { threadId: 'answer:1', commentId: '1', parentCommentId: '2' }, at), /已知根楼/);
  const detached = applyRelation(input, createOverrides(), { threadId: 'answer:1', commentId: '2', parentCommentId: null }, at);
  const linked = applyRelation(input, detached, { threadId: 'answer:1', commentId: '1', parentCommentId: '2' }, at);
  assert.equal(getRelations(input, linked)[0].effectiveParentCommentId, '2');
  assert.throws(() => resetRelation(input, linked, { threadId: 'answer:1', commentId: '2' }, at), /循环/);
});

test('known-root ancestry is checked alongside conflicting explicit original parents', () => {
  const input = archive([row('1'), row('2', { rootCommentId: '1', parentCommentId: '3' }), row('3')]);
  assert.throws(() => applyRelation(input, createOverrides(), { threadId: 'answer:1', commentId: '1', parentCommentId: '2' }, at), /循环/);
  const corrected = applyRelation(input, createOverrides(), { threadId: 'answer:1', commentId: '2', parentCommentId: '3' }, at);
  const moved = applyRelation(input, corrected, { threadId: 'answer:1', commentId: '1', parentCommentId: '2' }, at);
  assert.equal(getRelations(input, moved)[0].effectiveParentCommentId, '2');
});

test('an existing manual edit survives recapture while the changed original relation remains inspectable', () => {
  const initial = archive([row('1'), row('2', { rootCommentId: '1' }), row('3')]);
  const overrides = applyRelation(initial, createOverrides(), { threadId: 'answer:1', commentId: '2', parentCommentId: '1' }, at);
  const recaptured = archive([row('1'), row('2', { rootCommentId: '3', parentCommentId: '3' }), row('3')]);
  const resolved = getRelations(recaptured, overrides)[1];
  assert.equal(resolved.source, 'manual');
  assert.equal(resolved.originalParentCommentId, '3');
  assert.equal(resolved.effectiveParentCommentId, '1');
  const reset = resetRelation(recaptured, overrides, { threadId: 'answer:1', commentId: '2' }, at);
  assert.equal(getRelations(recaptured, reset)[1].effectiveParentCommentId, '3');
});

test('source ID aliases and identical IDs in different discussion types remain unambiguous', () => {
  const input = archive([row('local-a', { sourceId: '1', rootCommentId: '1' }), row('local-b', { sourceId: '2', rootCommentId: '1' }), row('1', { threadId: 'article:1' })]);
  const value = applyRelation(input, createOverrides(), { threadId: 'answer:1', commentId: 'local-b', parentCommentId: 'local-a' }, at);
  assert.equal(value.revisions[0].commentId, '2');
  assert.equal(value.revisions[0].parentCommentId, '1');
  assert.equal(getRelations(input, value)[2].source, 'original');
});

test('unrelated corrupt source cycles remain reviewable while another branch can be repaired', () => {
  const input = archive([row('1', { parentCommentId: '2' }), row('2', { parentCommentId: '1' }), row('3', { rootCommentId: null })]);
  const value = applyRelation(input, createOverrides(), { threadId: 'answer:1', commentId: '3', parentCommentId: null }, at);
  assert.deepEqual(getRelations(input, value).map(entry => entry.needsReview), [true, true, false]);
});

test('reviewed export keeps raw evidence and revisions separate and independently cloned', () => {
  const input = archive([row('1'), row('2', { rootCommentId: '1' })]);
  const overrides = applyRelation(input, createOverrides(), { threadId: 'answer:1', commentId: '2', parentCommentId: '1' }, at);
  const result = materializeRelations(input, overrides);
  assert.equal(result.format, 'gonglun-zhihu-reviewed');
  assert.equal(result.archive.comments[1].parentCommentId, null);
  assert.equal(result.relations[1].effectiveParentCommentId, '1');
  result.archive.comments[1].text = '技术测试修改';
  result.overrides.revisions[0].note = '技术测试修改';
  assert.equal(input.comments[1].text, '');
  assert.equal(overrides.revisions[0].note, '');
});

test('invalid edits and malformed histories fail explicitly without fabricating identities or dates', () => {
  const input = archive([row('1')]);
  assert.throws(() => applyRelation(input, createOverrides(), { threadId: 'answer:1', commentId: '1', parentCommentId: undefined }, at), /父评论/);
  assert.throws(() => applyRelation(input, createOverrides(), { threadId: 'answer:1', commentId: '1', parentCommentId: null }, '10-28'), /时间/);
  assert.throws(() => getRelations(input, { format: 'other', version: 1, revisions: [] }), /关系调整文件/);
});

test('version one histories remain readable and reviewed exports carry version two arrays', () => {
  const input = archive([row('1'), row('2', { rootCommentId: '1' })]);
  const legacy = { format: 'gonglun-zhihu-overrides', version: 1, revisions: [{ id: 'old-edit', action: 'set', threadId: 'answer:1', commentId: '2', parentCommentId: '1', createdAt: at }] };
  const relation = getRelations(input, legacy)[1];
  assert.deepEqual(relation.effectiveParentCommentIds, ['1']);
  assert.equal(relation.effectiveParentCommentId, '1');
  assert.equal(relation.method, 'manual');
  const reviewed = materializeRelations(input, legacy);
  assert.equal(reviewed.version, 2);
  assert.equal(reviewed.overrides.version, 2);
  assert.deepEqual(reviewed.overrides.revisions[0].parentCommentIds, ['1']);
  assert.equal(legacy.version, 1);
  assert.equal('parentCommentIds' in legacy.revisions[0], false);
});

test('set batches connect every source to all targets, preserving original evidence and one batch identity', () => {
  const input = archive([row('1'), row('2'), row('3'), row('4')]);
  const original = structuredClone(input);
  const empty = createOverrides();
  const result = applyRelationBatch(input, empty, { threadId: 'answer:1', mode: 'sets', sourceCommentIds: ['3', '4'], targetCommentIds: ['1', '2'], note: '结构测试' }, at);
  const resolved = getRelations(input, result);
  for (const relation of resolved.slice(2)) {
    assert.deepEqual(relation.effectiveParentCommentIds, ['1', '2']);
    assert.equal(relation.effectiveParentCommentId, null);
    assert.equal(relation.source, 'manual');
    assert.equal(relation.method, 'manual');
    assert.equal(relation.needsReview, false);
  }
  assert.equal(result.revisions.length, 2);
  assert.equal(new Set(result.revisions.map(value => value.batchId)).size, 1);
  assert.equal(new Set(result.revisions.map(value => value.id)).size, 2);
  assert.ok(result.revisions.every(value => value.beforeRevision === null));
  assert.equal(empty.revisions.length, 0);
  assert.deepEqual(input, original);
});

test('sequence fills only unknown relations in archive order and does not overwrite source or manual links', () => {
  const input = archive([
    row('5', { rootCommentId: null, createdAt: '2026-11-01T05:00:00Z' }),
    row('1'), row('2', { rootCommentId: null }), row('3', { rootCommentId: null }),
    row('4', { rootCommentId: null, createdAt: '2026-11-01T00:00:00Z' }),
  ]);
  const previous = applyRelation(input, createOverrides(), { threadId: 'answer:1', commentId: '3', parentCommentId: '1' }, at);
  const result = applyRelationBatch(input, previous, { threadId: 'answer:1', mode: 'sequence' }, at);
  const resolved = new Map(getRelations(input, result).map(value => [value.commentId, value]));
  assert.deepEqual(resolved.get('5').effectiveParentCommentIds, []);
  assert.equal(resolved.get('5').method, 'sequence');
  assert.equal(resolved.get('5').source, 'manual');
  assert.equal(resolved.get('1').source, 'original');
  assert.deepEqual(resolved.get('2').effectiveParentCommentIds, ['1']);
  assert.equal(resolved.get('3').revisionId, previous.revisions[0].id);
  assert.deepEqual(resolved.get('4').effectiveParentCommentIds, ['3']);
  assert.equal(result.revisions.length - previous.revisions.length, 3);
  assert.ok(result.revisions.slice(1).every(value => value.method === 'sequence'));
  assert.deepEqual(applyRelationBatch(input, result, { threadId: 'answer:1', mode: 'sequence' }, at), result);
});

test('sequence subsets use the preceding comment in the full thread rather than the preceding selected comment', () => {
  const input = archive([row('1'), row('2', { rootCommentId: null }), row('3'), row('4', { rootCommentId: null })]);
  const result = applyRelationBatch(input, createOverrides(), { threadId: 'answer:1', mode: 'sequence', sourceCommentIds: ['2', '4'] }, at);
  assert.deepEqual(result.revisions.map(value => value.parentCommentIds), [['1'], ['3']]);
});

test('a known but unavailable source parent is not overwritten by sequence initialization', () => {
  const input = archive([row('1'), row('2', { rootCommentId: null, parentCommentId: 'absent' })]);
  const result = applyRelationBatch(input, createOverrides(), { threadId: 'answer:1', mode: 'sequence' }, at);
  assert.equal(result.revisions.length, 0);
  assert.equal(getRelations(input, result)[1].effectiveParentCommentId, 'absent');
  assert.equal(getRelations(input, result)[1].needsReview, true);
});

test('overlapping sets, missing or cross-thread targets, and empty selections are rejected before any batch is applied', () => {
  const input = archive([row('1'), row('2'), row('3', { threadId: 'article:1' })]);
  const empty = createOverrides();
  const run = (sources, targets) => applyRelationBatch(input, empty, { threadId: 'answer:1', mode: 'sets', sourceCommentIds: sources, targetCommentIds: targets }, at);
  assert.throws(() => run(['1'], ['1', '2']), /同一条评论/);
  assert.throws(() => run(['1'], ['3']), /不存在/);
  assert.throws(() => run(['1'], ['absent']), /不存在/);
  assert.throws(() => run([], ['1']), /来源.*不能为空/);
  assert.throws(() => run(['1'], []), /目标.*不能为空/);
  assert.equal(empty.revisions.length, 0);
});

test('cycles through any target and sequence cycles reject the entire candidate batch', () => {
  const input = archive([row('1'), row('2', { rootCommentId: '1', parentCommentId: '1' }), row('3'), row('4')]);
  const empty = createOverrides();
  assert.throws(() => applyRelationBatch(input, empty, { threadId: 'answer:1', mode: 'sets', sourceCommentIds: ['4', '1'], targetCommentIds: ['3', '2'] }, at), /整批未保存/);
  assert.equal(empty.revisions.length, 0);
  const reversed = archive([row('1', { rootCommentId: '2', parentCommentId: '2' }), row('2', { rootCommentId: null })]);
  assert.throws(() => applyRelationBatch(reversed, empty, { threadId: 'answer:1', mode: 'sequence' }, at), /循环/);
  assert.equal(empty.revisions.length, 0);
});

test('batch undo restores prior manual, unknown and original states without deleting any history', () => {
  const input = archive([row('1'), row('2', { rootCommentId: null }), row('3', { rootCommentId: null }), row('4')]);
  const initial = applyRelation(input, createOverrides(), { threadId: 'answer:1', commentId: '2', parentCommentId: '1' }, at);
  const grouped = applyRelationBatch(input, initial, { threadId: 'answer:1', mode: 'sets', sourceCommentIds: ['2', '3', '4'], targetCommentIds: ['1'] }, at);
  const batchId = grouped.revisions.at(-1).batchId;
  const undone = undoRelationBatch(input, grouped, { threadId: 'answer:1', batchId }, at);
  const rows = new Map(getRelations(input, undone).map(value => [value.commentId, value]));
  assert.equal(rows.get('2').source, 'manual');
  assert.deepEqual(rows.get('2').effectiveParentCommentIds, ['1']);
  assert.equal(rows.get('3').source, 'unknown');
  assert.deepEqual(rows.get('3').effectiveParentCommentIds, []);
  assert.equal(rows.get('4').source, 'original');
  assert.equal(undone.revisions.length, grouped.revisions.length + 3);
  assert.ok(undone.revisions.slice(-3).every(value => value.undoOfBatchId === batchId));
  assert.equal(new Set(undone.revisions.slice(-3).map(value => value.batchId)).size, 1);
  assert.notEqual(undone.revisions.at(-1).batchId, batchId);
  assert.deepEqual(undone.revisions.slice(0, grouped.revisions.length), grouped.revisions);
  assert.throws(() => undoRelationBatch(input, undone, { threadId: 'answer:1', batchId }, at), /再次修改/);
});

test('undo restores sequence provenance and multi-target parents from the pre-batch snapshot', () => {
  const input = archive([row('1'), row('2'), row('3', { rootCommentId: null }), row('4')]);
  const sequence = applyRelationBatch(input, createOverrides(), { threadId: 'answer:1', mode: 'sequence' }, at);
  const changed = applyRelationBatch(input, sequence, { threadId: 'answer:1', mode: 'sets', sourceCommentIds: ['3'], targetCommentIds: ['1', '2'] }, at);
  const another = applyRelationBatch(input, changed, { threadId: 'answer:1', mode: 'sets', sourceCommentIds: ['3'], targetCommentIds: ['4'] }, at);
  const undoLast = undoRelationBatch(input, another, { threadId: 'answer:1', batchId: another.revisions.at(-1).batchId }, at);
  assert.deepEqual(getRelations(input, undoLast)[2].effectiveParentCommentIds, ['1', '2']);
  const undoChanged = undoRelationBatch(input, changed, { threadId: 'answer:1', batchId: changed.revisions.at(-1).batchId }, at);
  assert.equal(getRelations(input, undoChanged)[2].method, 'sequence');
  assert.deepEqual(getRelations(input, undoChanged)[2].effectiveParentCommentIds, ['2']);
});

test('a later edit of any batch subject prevents the entire undo from covering it', () => {
  const input = archive([row('1'), row('2'), row('3')]);
  const grouped = applyRelationBatch(input, createOverrides(), { threadId: 'answer:1', mode: 'sets', sourceCommentIds: ['2', '3'], targetCommentIds: ['1'] }, at);
  const batchId = grouped.revisions.at(-1).batchId;
  const later = applyRelation(input, grouped, { threadId: 'answer:1', commentId: '3', parentCommentId: null }, at);
  const saved = structuredClone(later);
  assert.throws(() => undoRelationBatch(input, later, { threadId: 'answer:1', batchId }, at), /之后已有评论被再次修改/);
  assert.deepEqual(later, saved);
});

test('undo checks the final graph and refuses all restorations if unrelated subsequent links make a cycle', () => {
  const input = archive([row('1'), row('2'), row('3'), row('4')]);
  const before = applyRelation(input, createOverrides(), { threadId: 'answer:1', commentId: '2', parentCommentId: '1' }, at);
  const grouped = applyRelationBatch(input, before, { threadId: 'answer:1', mode: 'sets', sourceCommentIds: ['2', '3'], targetCommentIds: ['4'] }, at);
  const after = applyRelation(input, grouped, { threadId: 'answer:1', commentId: '1', parentCommentId: '2' }, at);
  const saved = structuredClone(after);
  assert.throws(() => undoRelationBatch(input, after, { threadId: 'answer:1', batchId: grouped.revisions.at(-1).batchId }, at), /整批未保存/);
  assert.deepEqual(after, saved);
});
