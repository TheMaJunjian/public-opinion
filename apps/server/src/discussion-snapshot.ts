import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isRelationView, relations, type Message, type WorkbenchSnapshot } from '@gonglun/core';
import { DomainError, type Store } from './db.js';
import { primaryRelationSql, isDependentMessageSql, isSettlementRecordSql } from './display-dependencies.js';
import { attentionUsers, primaryRelation, stakesFor, tagCountsFor, usersFor, viewsFor } from './ui-projections.js';
import { assertMessageReadable } from './moderation-visibility.js';

const id = z.string().min(1).max(100);
const querySchema = z.object({ focusId: id, classificationId: id.nullable().optional(), cursor: z.string().max(1000).optional(),
  extraIds: z.array(id).max(50).default([]), recordIds: z.array(id).max(100).default([]),
  trace: z.object({ ids: z.array(id).min(1).max(50), depths: z.object({ up: z.number().int().min(0).max(10), down: z.number().int().min(0).max(10) }), expandedIds: z.array(id).max(100) }).optional(),
}).strict();
const cursorSchema = z.object({ key: z.string(), through: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), id });
const containers = new Set(['classify', 'summary', 'merge', 'arrange']);
const effects = ['agree','disagree','correct','amend','annotation','tag','recommend','archive','low-quality','follow','unfollow','block','unblock','read','unread'];
const PAGE_SIZE = 20, CONTEXT_LIMIT = 600;
const tooLarge = () => new DomainError('这段讨论的必要关联超过单页上限，请打开完整工作台查看，或选择更具体的消息', 422, 'DISCUSSION_TOO_LARGE');

/** Indexed selection + complete semantic closure. Never traverses an unopened category's bodies. */
export async function discussionSnapshot(store: Store, raw: unknown, userId: string): Promise<WorkbenchSnapshot> {
  const query = querySchema.parse(raw), focus = await store.message(query.focusId);
  await assertMessageReadable(store, focus.id, userId);
  const category = query.classificationId ?? (containers.has(primaryRelation(focus)?.relation ?? '') ? focus.id : null);
  if (category) await assertMessageReadable(store, category, userId);
  const regionId = await store.setting<string>('region'), sequence = await store.latestSequence();
  // Extra editing/reading context does not change the page's candidate order.
  const { cursor: _cursor, extraIds: _extras, recordIds: _records, ...selection } = query;
  const key = createHash('sha256').update(JSON.stringify([regionId, userId, selection])).digest('hex');
  let cursor = { key, through: sequence, sequence: Number.MAX_SAFE_INTEGER, id: '~' };
  if (query.cursor) {
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString())); }
    catch { throw new DomainError('分页地址无效，请刷新讨论'); }
    if (cursor.key !== key || cursor.through > sequence) throw new DomainError('讨论范围已变化，请刷新后继续', 409, 'DISCUSSION_EXPIRED');
  }
  let traceIds: string[] | undefined;
  if (query.trace) {
    const seeds = [...new Set([...query.trace.ids, ...query.trace.expandedIds])];
    const selected = new Set(seeds);
    for (const direction of ['up','down'] as const) {
      // Each direction starts at the requested origins. An upstream result
      // must not seed a downstream walk through unrelated sibling discussions.
      const seen = new Set(seeds);
      let frontier = seeds;
      for (let depth = 0; depth < query.trace.depths[direction] && frontier.length; depth++) {
        // refs indexes every binding, including the relation's semantic source.
        // Resolve the roles before walking; reversing refs alone reverses source
        // bindings and loses upstream links owned by separate relation records.
        const steps = direction === 'up'
          ? `SELECT unnest(ARRAY[link.id,link.target]) AS id WHERE link.source=ANY($1::text[]) OR link.id=ANY($1::text[])
             UNION SELECT link.source WHERE link.id=ANY($1::text[])`
          : `SELECT unnest(ARRAY[link.id,link.source]) AS id WHERE link.target=ANY($1::text[])`;
        const rows = await store.db.prepare(`WITH candidates AS (
          SELECT m.id,${primaryRelationSql('m')} AS action FROM messages m WHERE m.id IN (
            SELECT unnest($1::text[]) UNION SELECT "sourceId" FROM refs WHERE "targetId"=ANY($1::text[])
          ) AND NOT ${isSettlementRecordSql('m')}
        ), links AS (
          SELECT c.id,COALESCE(c.action #>> '{roles,source,0,reference,messageId}',c.action #>> '{roles,reason,0,reference,messageId}',c.id) AS source,
            binding #>> '{reference,messageId}' AS target
          FROM candidates c,jsonb_array_elements(COALESCE(c.action #> '{roles,target}',c.action #> '{roles,members}',c.action #> '{roles,member}','[]'::jsonb)) binding
          WHERE c.action->>'relation' NOT IN ('member-of','classify','summary','merge','arrange','read','unread')
        ) SELECT DISTINCT destination.id FROM links link CROSS JOIN LATERAL (${steps}) destination
          WHERE destination.id IS NOT NULL LIMIT $2`).all<{id:string}>(frontier, CONTEXT_LIMIT + 1);
        frontier = rows.map(row => row.id).filter(id => !seen.has(id));
        frontier.forEach(id => { seen.add(id); selected.add(id); });
        if (selected.size > CONTEXT_LIMIT) throw tooLarge();
      }
    }
    traceIds = [...selected];
  }
  const params: unknown[] = [traceIds ?? category ?? focus.id, cursor.through, cursor.sequence, cursor.id, PAGE_SIZE + 1, focus.id];
  const selectionSql = traceIds ? 'm.id=ANY($1::text[])'
    : category ? `EXISTS(SELECT 1 FROM memberships mm WHERE mm."memberId"=m.id AND mm."parentId"=$1) AND NOT ${isDependentMessageSql('m')}`
    : `m.id IN (SELECT "sourceId" FROM refs WHERE "targetId"=$1 UNION SELECT "targetId" FROM refs WHERE "sourceId"=$1)
      AND COALESCE(${primaryRelationSql('m')}->>'relation','') NOT IN ('${[...effects,'member-of'].join("','")}')`;
  const rows = await store.db.prepare(`SELECT m.body FROM messages m WHERE ${selectionSql} AND m.id<>$6
    AND NOT ${isSettlementRecordSql('m')} AND m.sequence<=$2 AND (m.sequence,m.id)<($3,$4)
    ORDER BY m.sequence DESC,m.id DESC LIMIT $5`).all(...params);
  const page = rows.slice(0, PAGE_SIZE).map(row => JSON.parse(String(row.body)) as Message);
  const records = new Map<string, Message>([[focus.id, focus], ...page.map(message => [message.id, message] as const)]);
  const fetched = new Set<string>();
  let pending = [...new Set([focus.id, ...page.map(message => message.id), ...query.extraIds, ...query.recordIds, ...(category ? [category] : []), ...query.trace?.ids ?? []])];
  // Never publish a truncated correction, stance or membership competition.
  for (let wave = 0; pending.length; wave++) {
    if (wave >= 40 || fetched.size + pending.length > CONTEXT_LIMIT) throw tooLarge();
    const batch = pending; pending = []; batch.forEach(id => fetched.add(id));
    const loaded = await store.db.prepare('SELECT body FROM messages WHERE id=ANY($1::text[])').all(batch);
    for (const row of loaded) { const message = JSON.parse(String(row.body)) as Message; records.set(message.id, message); }
    const needed = new Set<string>();
    for (const currentId of batch) {
      const message = records.get(currentId); if (!message) continue;
      const primary = primaryRelation(message);
      // Organization roles describe unopened members. Their original native
      // parts remain intact; only requested members enter the rendered model.
      if (!containers.has(primary?.relation ?? '')) for (const part of relations(message))
        for (const binding of Object.values(part.roles).flat()) needed.add(binding.reference.messageId);
      for (const part of message.parts) if (part.type === 'display' && part.target) needed.add(part.target.messageId);
    }
    const parents = await store.db.prepare('SELECT "parentId","sourceId" FROM memberships WHERE "memberId"=ANY($1::text[])').all(batch);
    for (const row of parents) { needed.add(String(row.parentId)); needed.add(String(row.sourceId)); }
    const affecting = await store.db.prepare(`SELECT DISTINCT m.id FROM refs r JOIN messages m ON m.id=r."sourceId"
      WHERE r."targetId"=ANY($1::text[]) AND (
        (${primaryRelationSql('m')}->>'relation') IN ('${effects.join("','")}')
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(m.body::jsonb->'parts') part,
          jsonb_array_elements(part->'roles'->'member') binding WHERE part->>'relation'='member-of' AND binding #>> '{reference,messageId}'=r."targetId")
      ) LIMIT $2`).all<{id:string}>(batch, CONTEXT_LIMIT + 1);
    for (const row of affecting) needed.add(row.id);
    pending = [...needed].filter(id => !fetched.has(id) && id !== 'root');
  }
  const all = [...records.values()], ids = all.map(message => message.id);
  const users = await usersFor(store, all.map(message => message.authorId));
  const views = await viewsFor(store, all, 'root', users, false, new Set(ids));
  const memberCounts: NonNullable<WorkbenchSnapshot['discussion']>['memberCounts'] = {};
  const organizationIds = all.filter(message => containers.has(primaryRelation(message)?.relation ?? '')).map(message => message.id);
  if (organizationIds.length) {
    const counts = await store.db.prepare(`WITH RECURSIVE tree(root,id) AS (
      SELECT "parentId","memberId" FROM memberships WHERE "parentId"=ANY($1::text[])
      UNION SELECT tree.root,mm."memberId" FROM tree JOIN memberships mm ON mm."parentId"=tree.id
    ) SELECT root,COUNT(*) FILTER(WHERE id<>root) AS total,
      (SELECT COUNT(*) FROM memberships mm WHERE mm."parentId"=root AND mm."memberId"<>root) AS direct FROM tree GROUP BY root`).all(organizationIds);
    for (const row of counts) memberCounts[String(row.root)] = { direct: Number(row.direct), total: Number(row.total) };
  }
  const last = page.at(-1);
  const nextCursor = rows.length > PAGE_SIZE && last ? Buffer.from(JSON.stringify({ key, through: cursor.through, sequence: last.sequence, id: last.id })).toString('base64url') : null;
  return { regionId, sequence, scope: { messageId: null, title: '当前讨论' }, messages: views, relations: views.filter(isRelationView), users,
    stakes: await stakesFor(store, ids, users), tagCounts: await tagCountsFor(store, ids), attentionUsers: await attentionUsers(store, ids),
    discussion: { focusId: focus.id, pageIds: page.map(message => message.id), nextCursor, memberCounts } };
}
