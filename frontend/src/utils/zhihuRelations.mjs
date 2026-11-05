/** Manual relationship corrections are an append-only overlay on source records. */
const FORMAT = 'gonglun-zhihu-overrides';
const keyOf = (threadId, commentId) => JSON.stringify([threadId, commentId]);
const identifier = (value, label) => {
  if (typeof value !== 'string' || !value) throw new TypeError(`${label}必须是非空字符串`);
  return value;
};

export function createOverrides() {
  return { format: FORMAT, version: 2, revisions: [] };
}

function parentIds(value) {
  let ids;
  if (Object.hasOwn(value, 'parentCommentIds')) {
    if (!Array.isArray(value.parentCommentIds)) throw new TypeError('回复目标必须是编号数组');
    ids = [...new Set(value.parentCommentIds.map(entry => identifier(entry, '父评论编号')))];
    const scalar = ids.length === 1 ? ids[0] : null;
    if (Object.hasOwn(value, 'parentCommentId') && value.parentCommentId !== scalar) throw new TypeError('单个回复目标与回复目标数组不一致');
  } else {
    ids = value.parentCommentId === null ? [] : [identifier(value.parentCommentId, '父评论编号')];
  }
  return ids;
}
function methodOf(revision) { return revision.action === 'set' ? revision.method || 'manual' : null; }

function validateOverrides(value) {
  if (value?.format !== FORMAT || ![1, 2].includes(value.version) || !Array.isArray(value.revisions)) throw new TypeError('不支持的关系调整文件');
  const ids = new Set();
  for (const revision of value.revisions) {
    identifier(revision?.id, '修订编号');
    if (ids.has(revision.id)) throw new TypeError('关系调整文件包含重复修订编号');
    ids.add(revision.id);
    identifier(revision.threadId, '讨论编号');
    identifier(revision.commentId, '评论编号');
    if (!['set', 'reset'].includes(revision.action)) throw new TypeError('关系调整动作无效');
    if (revision.action === 'set') parentIds(revision);
    if (revision.method !== undefined && revision.method !== null && !['sequence', 'manual'].includes(revision.method)) throw new TypeError('关系整理方法无效');
    if (revision.batchId !== undefined) identifier(revision.batchId, '批次编号');
    if (revision.undoOfBatchId !== undefined) identifier(revision.undoOfBatchId, '被撤销批次编号');
    if (revision.note !== undefined && typeof revision.note !== 'string') throw new TypeError('调整说明必须是文字');
    if (typeof revision.createdAt !== 'string') throw new TypeError('关系调整时间无效');
    at(revision.createdAt);
  }
  return value;
}

function upgradeOverrides(value) {
  validateOverrides(value);
  return { format: FORMAT, version: 2, revisions: value.revisions.map(revision => {
    const next = { ...structuredClone(revision), method: methodOf(revision) };
    if (revision.action === 'set') {
      next.parentCommentIds = parentIds(revision);
      next.parentCommentId = next.parentCommentIds.length === 1 ? next.parentCommentIds[0] : null;
    }
    return next;
  }) };
}

function commentIndex(archive) {
  if (!archive || !Array.isArray(archive.comments)) throw new TypeError('归档缺少评论列表');
  const records = new Map();
  const aliases = new Map();
  for (const comment of archive.comments) {
    const threadId = identifier(comment.threadId, '讨论编号');
    const commentId = identifier(comment.sourceId || comment.id, '评论编号');
    const key = keyOf(threadId, commentId);
    if (records.has(key)) throw new TypeError('同一讨论包含重复评论编号，无法可靠调整关系');
    records.set(key, { key, threadId, commentId, comment });
    for (const alias of new Set([commentId, comment.id].filter(Boolean))) {
      identifier(alias, '评论编号');
      const aliasKey = keyOf(threadId, alias);
      if (aliases.has(aliasKey) && aliases.get(aliasKey) !== key) throw new TypeError('评论编号别名有冲突，无法可靠调整关系');
      aliases.set(aliasKey, key);
    }
  }
  const resolve = (threadId, commentId) => commentId === null || commentId === undefined ? null : records.get(aliases.get(keyOf(threadId, commentId))) || null;
  return { records, resolve };
}

function relationIssue(comment) {
  return (comment.issues || []).some(value => {
    const code = typeof value === 'string' ? value : value?.code || '';
    return /parent|root|reply|relation|context|父评论|根评论|回复对象|关系/.test(code);
  });
}

function build(archive, overrides) {
  validateOverrides(overrides);
  const index = commentIndex(archive);
  const latest = new Map();
  // Append order is authoritative. Timestamps are evidence, not a sort key.
  for (const revision of overrides.revisions) {
    const record = index.resolve(revision.threadId, revision.commentId);
    if (record) latest.set(record.key, revision);
  }
  const rows = new Map();
  for (const record of index.records.values()) {
    const { comment, threadId, commentId, key } = record;
    const originalParentCommentId = comment.parentCommentId ?? null;
    if (originalParentCommentId !== null) identifier(originalParentCommentId, '原始父评论编号');
    const originalParent = index.resolve(threadId, originalParentCommentId);
    const root = index.resolve(threadId, comment.rootCommentId);
    const originalRoot = !originalParentCommentId && root?.key === key && !comment.replyToAuthor && !relationIssue(comment);
    const revision = latest.get(key);
    const manual = revision?.action === 'set';
    const selectedParentIds = manual ? parentIds(revision) : originalParentCommentId ? [originalParentCommentId] : [];
    const parents = selectedParentIds.map(parentId => index.resolve(threadId, parentId));
    const effectiveParentCommentIds = [...new Set(selectedParentIds.map((parentId, position) => parents[position]?.commentId || parentId))];
    const source = manual ? 'manual' : originalParentCommentId || originalRoot ? 'original' : 'unknown';
    const row = {
      threadId, commentId, originalParentCommentId,
      effectiveParentCommentIds,
      effectiveParentCommentId: effectiveParentCommentIds.length === 1 ? effectiveParentCommentIds[0] : null,
      source, ...(revision ? { revisionId: revision.id } : {}),
      method: manual ? methodOf(revision) : null,
      ...(revision?.batchId ? { batchId: revision.batchId } : {}),
      needsReview: source === 'unknown' || parents.some(parent => !parent),
    };
    // A root is ancestry evidence, never an inferred direct reply. Include it
    // alongside an original parent: conflicting source evidence must not hide a
    // cycle. A manual override explicitly replaces the original ancestry claim.
    const rootEvidence = !manual && root && root.key !== key ? root.key : null;
    rows.set(key, { row, parentKeys: parents.flatMap(parent => parent ? [parent.key] : []), rootEvidence, record });
  }
  return { ...index, rows, latest };
}

function ancestorKeys(entry) { return [...new Set([...(entry?.parentKeys || []), entry?.rootEvidence].filter(Boolean))]; }
function cycleReachability(rows) {
  const colors = new Map();
  const positions = new Map();
  const cycles = new Set();
  const reverse = new Map();
  for (const [key, entry] of rows) {
    for (const target of ancestorKeys(entry)) {
      if (!reverse.has(target)) reverse.set(target, []);
      reverse.get(target).push(key);
    }
  }
  for (const start of rows.keys()) {
    if (colors.has(start)) continue;
    const stack = [];
    const push = key => {
      positions.set(key, stack.length);
      colors.set(key, 1);
      stack.push({ key, targets: ancestorKeys(rows.get(key)).filter(target => rows.has(target)), index: 0 });
    };
    push(start);
    while (stack.length) {
      const current = stack.at(-1);
      if (current.index >= current.targets.length) {
        colors.set(current.key, 2);
        positions.delete(current.key);
        stack.pop();
        continue;
      }
      const target = current.targets[current.index++];
      if (!colors.has(target)) push(target);
      else if (colors.get(target) === 1) {
        for (let index = positions.get(target); index < stack.length; index++) cycles.add(stack[index].key);
      }
    }
  }
  // Mark dependent paths too; a direct link into a source cycle still needs review.
  const affected = new Set(cycles);
  const pending = [...cycles];
  for (let index = 0; index < pending.length; index++) {
    for (const dependent of reverse.get(pending[index]) || []) {
      if (affected.has(dependent)) continue;
      affected.add(dependent);
      pending.push(dependent);
    }
  }
  return affected;
}

/** Resolve current links without overwriting or filling in source relationships. */
export function getRelations(archive, overrides = createOverrides()) {
  const view = build(archive, overrides);
  const cycles = cycleReachability(view.rows);
  return [...view.rows.entries()].map(([key, { row }]) => ({ ...row, needsReview: row.needsReview || cycles.has(key) }));
}

function at(value) {
  const current = typeof value === 'function' ? value() : value;
  if (typeof current === 'string' && !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(current)) throw new TypeError('关系调整时间无效');
  const date = new Date(current ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new TypeError('关系调整时间无效');
  return date.toISOString();
}
function noteOf(input) {
  const note = input?.note ?? '';
  if (typeof note !== 'string') throw new TypeError('调整说明必须是文字');
  if (note.length > 10000) throw new TypeError('调整说明不能超过 10000 个字符');
  return note;
}
function previousRevision(view, subject) {
  const previous = view.latest.get(subject.key);
  if (!previous) return null;
  // A compact state snapshot, not a recursively nested copy of prior history.
  return {
    id: previous.id, action: previous.action, method: methodOf(previous),
    ...(previous.action === 'set' ? { parentCommentIds: parentIds(previous) } : {}),
    ...(previous.batchId ? { batchId: previous.batchId } : {}),
    note: previous.note || '', createdAt: previous.createdAt,
  };
}
function findSubject(view, threadId, commentId) {
  const subject = view.resolve(threadId, identifier(commentId, '评论编号'));
  if (!subject) throw new Error('要调整的评论不存在于该讨论中');
  return subject;
}
function findParents(view, subject, ids) {
  return [...new Set(ids.map(parentId => {
    const parent = view.resolve(subject.threadId, identifier(parentId, '父评论编号'));
    if (!parent) throw new Error('父评论不存在于同一讨论中，不能跨讨论连接');
    if (parent.key === subject.key) throw new Error('评论不能回复自身');
    return parent.commentId;
  }))];
}
function setRevision(view, subject, ids, { note, createdAt, method = 'manual', batchId, undoOfBatchId, restoredFromRevisionId } = {}) {
  const targets = findParents(view, subject, ids);
  return {
    id: globalThis.crypto.randomUUID(), action: 'set', threadId: subject.threadId, commentId: subject.commentId,
    parentCommentIds: targets, parentCommentId: targets.length === 1 ? targets[0] : null,
    method, note, createdAt, beforeRevision: previousRevision(view, subject),
    ...(batchId ? { batchId } : {}), ...(undoOfBatchId ? { undoOfBatchId } : {}),
    ...(restoredFromRevisionId ? { restoredFromRevisionId } : {}),
  };
}
function resetRevision(view, subject, { note, createdAt, batchId, undoOfBatchId, restoredFromRevisionId } = {}) {
  return {
    id: globalThis.crypto.randomUUID(), action: 'reset', threadId: subject.threadId, commentId: subject.commentId,
    method: null, note, createdAt, beforeRevision: previousRevision(view, subject),
    ...(batchId ? { batchId } : {}), ...(undoOfBatchId ? { undoOfBatchId } : {}),
    ...(restoredFromRevisionId ? { restoredFromRevisionId } : {}),
  };
}
function appendValidated(archive, overrides, revisions, subjects) {
  const next = upgradeOverrides(overrides);
  next.revisions.push(...revisions);
  const candidate = build(archive, next);
  // Validate the completed transaction, never a partially applied batch. A new
  // cycle must include at least one changed outgoing edge.
  // Unrelated pre-existing source errors remain reviewable rather than blocking
  // the user from repairing another branch.
  const cycles = cycleReachability(candidate.rows);
  if (subjects.some(subject => cycles.has(subject.key))) throw new Error('该调整会形成回复循环（包括原站已知根楼关系），整批未保存');
  return next;
}

/** Empty parentCommentIds, or legacy parentCommentId:null, explicitly mean top level. */
export function applyRelation(archive, overrides, input, now) {
  const view = build(archive, overrides);
  const subject = findSubject(view, identifier(input?.threadId, '讨论编号'), input.commentId);
  return appendValidated(archive, overrides, [setRevision(view, subject, parentIds(input), { note: noteOf(input), createdAt: at(now) })], [subject]);
}

/** Append a reset event; original evidence and prior manual edits stay intact. */
export function resetRelation(archive, overrides, input, now) {
  const view = build(archive, overrides);
  const subject = findSubject(view, identifier(input?.threadId, '讨论编号'), input.commentId);
  return appendValidated(archive, overrides, [resetRevision(view, subject, { note: noteOf(input), createdAt: at(now) })], [subject]);
}

function selection(view, threadId, ids, label) {
  if (!Array.isArray(ids) || !ids.length) throw new TypeError(`${label}集合不能为空`);
  const selected = ids.map(commentId => findSubject(view, threadId, commentId));
  return [...new Map(selected.map(record => [record.key, record])).values()];
}

/**
 * sequence uses the archive's current order, not dates or a filtered subsequence.
 * sets replaces every selected source's targets with the complete target set.
 * No pending sequence rows is a no-op (no revision or batch is appended).
 */
export function applyRelationBatch(archive, overrides, input, now) {
  const view = build(archive, overrides);
  const threadId = identifier(input?.threadId, '讨论编号');
  const ordered = [...view.records.values()].filter(record => record.threadId === threadId);
  if (!ordered.length) throw new Error('要整理的讨论不存在或没有评论');
  if (!['sequence', 'sets'].includes(input.mode)) throw new TypeError('批量整理模式无效');
  const note = noteOf(input);
  let changes;
  if (input.mode === 'sequence') {
    if (input.targetCommentIds !== undefined && (!Array.isArray(input.targetCommentIds) || input.targetCommentIds.length)) throw new TypeError('按顺序整理不接受目标集合');
    const chosen = input.sourceCommentIds === undefined ? null : new Set(selection(view, threadId, input.sourceCommentIds, '来源').map(record => record.key));
    changes = ordered.flatMap((subject, index) => {
      const current = view.rows.get(subject.key).row;
      if (current.source !== 'unknown' || !current.needsReview || chosen && !chosen.has(subject.key)) return [];
      return [{ subject, targets: index === 0 ? [] : [ordered[index - 1].commentId] }];
    });
  } else {
    const sources = selection(view, threadId, input.sourceCommentIds, '来源');
    const targets = selection(view, threadId, input.targetCommentIds, '目标');
    const sourceKeys = new Set(sources.map(record => record.key));
    if (targets.some(record => sourceKeys.has(record.key))) throw new Error('来源集合和目标集合不能包含同一条评论');
    changes = sources.map(subject => ({ subject, targets: targets.map(record => record.commentId) }));
  }
  if (!changes.length) return upgradeOverrides(overrides);
  const batchId = globalThis.crypto.randomUUID();
  const createdAt = at(now);
  const method = input.mode === 'sequence' ? 'sequence' : 'manual';
  const revisions = changes.map(({ subject, targets }) => setRevision(view, subject, targets, { note, createdAt, method, batchId }));
  return appendValidated(archive, overrides, revisions, changes.map(value => value.subject));
}

/** Restore a whole untouched batch through new history records; never erase it. */
export function undoRelationBatch(archive, overrides, input, now) {
  const view = build(archive, overrides);
  const threadId = identifier(input?.threadId, '讨论编号');
  const requestedBatchId = identifier(input?.batchId, '批次编号');
  const batch = overrides.revisions.filter(revision => revision.batchId === requestedBatchId);
  if (!batch.length || batch.some(revision => revision.threadId !== threadId || revision.undoOfBatchId)) throw new Error('找不到该讨论中可撤销的原始批次');
  const subjects = batch.map(revision => findSubject(view, threadId, revision.commentId));
  if (new Set(subjects.map(subject => subject.key)).size !== subjects.length) throw new Error('批次包含重复评论，无法完整撤销');
  for (let index = 0; index < batch.length; index++) {
    const revision = batch[index];
    if (view.latest.get(subjects[index].key)?.id !== revision.id) throw new Error('此批次之后已有评论被再次修改，整批撤销已拒绝，避免覆盖后续调整');
    if (!Object.hasOwn(revision, 'beforeRevision')) throw new Error('该批次缺少调整前的记录，无法可靠撤销');
  }
  const batchId = globalThis.crypto.randomUUID();
  const createdAt = at(now);
  const note = noteOf(input);
  const revisions = batch.map((revision, index) => {
    const before = revision.beforeRevision;
    if (before !== null && (!before || !['set', 'reset'].includes(before.action))) throw new TypeError('批次的调整前记录无效');
    const details = { note, createdAt, batchId, undoOfBatchId: requestedBatchId, ...(before?.id ? { restoredFromRevisionId: before.id } : {}) };
    if (before?.action === 'set') {
      const restoredMethod = methodOf(before);
      if (!['sequence', 'manual'].includes(restoredMethod)) throw new TypeError('批次的原整理方法无效');
      return setRevision(view, subjects[index], parentIds(before), { ...details, method: restoredMethod });
    }
    return resetRevision(view, subjects[index], details);
  });
  return appendValidated(archive, overrides, revisions, subjects);
}

/** Independent reviewed export, preserving both source archive and edit log. */
export function materializeRelations(archive, overrides = createOverrides(), { copyArchive = true } = {}) {
  return {
    format: 'gonglun-zhihu-reviewed', version: 2,
    archive: copyArchive ? structuredClone(archive) : archive, relations: getRelations(archive, overrides), overrides: upgradeOverrides(overrides),
  };
}
