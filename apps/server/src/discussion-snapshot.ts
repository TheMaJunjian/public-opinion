import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isRelationView, relations, type Message, type WorkbenchSnapshot } from '@gonglun/core';
import { DomainError, type Store } from './db.js';
import { primaryRelationSql, displayAttachmentSql, isDependentMessageSql, isReviewDiscussionSql, isSettlementRecordSql } from './display-dependencies.js';
import { attentionUsers, primaryRelation, stakesFor, tagCountsFor, usersFor, viewsFor } from './ui-projections.js';
import { assertMessageReadable, inaccessibleMessages, sanitizeModeration } from './moderation-visibility.js';
import { recommendedClassificationPath } from './recommended-memberships.js';
import { publicReviewDecisions } from './review-decision-views.js';
import { hasModerationTables } from './moderation-schema.js';

const id = z.string().min(1).max(100);
const querySchema = z.object({ focusId: id, classificationId: id.nullable().optional(), cursor: z.string().max(1000).optional(),
  includeReviewVotes: z.boolean().optional(),
  extraIds: z.array(id).max(50).default([]), recordIds: z.array(id).max(100).default([]),
  trace: z.object({ ids: z.array(id).min(1).max(50), depths: z.object({ up: z.number().int().min(0).max(10), down: z.number().int().min(0).max(10) }), expandedIds: z.array(id).max(100) }).optional(),
}).strict();
const cursorSchema = z.object({ key: z.string(), through: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), id });
const containers = new Set(['classify', 'summary', 'merge', 'arrange']);
const effects = ['agree','disagree','correct','amend','annotation','tag','recommend','archive','low-quality','attention','follow','unfollow','block','unblock','read','unread'];
const PAGE_SIZE = 20, CONTEXT_LIMIT = 600;
const tooLarge = () => new DomainError('这段讨论的必要关联超过单页上限，请打开完整工作台查看，或选择更具体的消息', 422, 'DISCUSSION_TOO_LARGE');

/** Indexed selection + complete semantic closure. Never traverses an unopened category's bodies. */
export async function discussionSnapshot(store: Store, raw: unknown, userId: string): Promise<WorkbenchSnapshot> {
  const { includeReviewVotes, ...query } = querySchema.parse(raw);
  const snapshot = await readDiscussion(store, query, userId);
  if (!includeReviewVotes || !await hasModerationTables(store)) return snapshot;
  // Fetch only the signed vote facts for the versions on this page. Reasons and
  // other discussion records belong to the independently projected review case.
  const hosts = snapshot.messages.map(({ id, revision }) => ({ id, revision }));
  const versions = await store.db.prepare(`SELECT v."messageId" AS id,(m.body::jsonb->>'revision')::integer AS revision
    FROM jsonb_to_recordset($1::jsonb) host(id text,revision integer)
    JOIN moderation_cases c ON c."messageId"=host.id AND c.revision=host.revision
    JOIN moderation_votes v ON v."caseId"=c.id JOIN messages m ON m.id=v."messageId"
    WHERE NOT(v."messageId"=ANY($2::text[])) ORDER BY m.sequence,m.id LIMIT $3`)
    .all<{ id: string; revision: number }>(JSON.stringify(hosts), hosts.map(host => host.id), CONTEXT_LIMIT + 1);
  if (!versions.length) return snapshot;
  if (snapshot.messages.length + versions.length > CONTEXT_LIMIT) throw tooLarge();
  const votes = [...(await publicReviewDecisions(store, versions)).values()];
  const users = new Map(snapshot.users.map(user => [user.id, user]));
  for (const vote of votes) users.set(vote.createdBy.id, vote.createdBy);
  return { ...snapshot, messages: [...snapshot.messages, ...votes], relations: [...snapshot.relations, ...votes], users: [...users.values()] };
}

async function readDiscussion(store: Store, query: Omit<z.infer<typeof querySchema>, 'includeReviewVotes'>, userId: string): Promise<WorkbenchSnapshot> {
  const focus = await store.message(query.focusId);
  if((await inaccessibleMessages(store,[focus.id],userId)).size){
    // A direct link can open the public review records from this one card.
    // Discard the requested neighborhood, pagination, and trace around a hidden focus.
    const [view]=await viewsFor(store,[focus],undefined,undefined,true);
    const card=await sanitizeModeration(store,view!,userId);
    return {regionId:await store.setting<string>('region'),sequence:await store.latestSequence(),scope:{messageId:null,title:'当前讨论'},
      messages:[card],relations:isRelationView(card)?[card]:[],users:[card.createdBy],stakes:{},tagCounts:{},attentionUsers:{},
      discussion:{focusId:focus.id,pageIds:[],expandedIds:[focus.id],nextCursor:null,memberCounts:{}}};
  }
  const category = query.classificationId ?? (containers.has(primaryRelation(focus)?.relation ?? '') ? focus.id : null);
  if (category && category !== 'root') await assertMessageReadable(store, category, userId);
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
    : category ? `((COALESCE((SELECT mm."parentId" FROM memberships mm WHERE mm."memberId"=m.id),'root')=$1)
      OR EXISTS(SELECT 1 FROM membership_actions a WHERE a.body->>'memberId'=m.id AND a.body->>'parentId'=$1 AND NOT a.disabled))
      AND NOT ${isDependentMessageSql('m')}`
    : `m.id IN (SELECT "sourceId" FROM refs WHERE "targetId"=$1)
      AND COALESCE(${primaryRelationSql('m')}->>'relation','') NOT IN ('${[...effects,...containers,'member-of','join'].join("','")}')
      AND NOT ${isReviewDiscussionSql('m')}
      AND EXISTS(SELECT 1 FROM ${primaryRelationSql('m')} semantic,jsonb_each(semantic.value->'roles') role,
        jsonb_array_elements(role.value) binding WHERE role.key IN ('source','reason','target') AND binding #>> '{reference,messageId}'=$1)`;
  const rows = await store.db.prepare(`SELECT m.body FROM messages m WHERE ${selectionSql} AND m.id<>$6
    AND NOT ${isSettlementRecordSql('m')} AND m.sequence<=$2 AND (m.sequence,m.id)<($3,$4)
    ORDER BY m.sequence DESC,m.id DESC LIMIT $5`).all(...params);
  const page = rows.slice(0, PAGE_SIZE).map(row => JSON.parse(String(row.body)) as Message);
  const records = new Map<string, Message>([[focus.id, focus], ...page.map(message => [message.id, message] as const)]);
  // Context supplies a referenced body or ancestor, relation supplies its direct
  // endpoints, and body additionally opens its inline members/owned links. Merely
  // mentioning a message must not recursively open that message's discussion.
  const context = 0, relation = 1, body = 2;
  const requested = new Map<string, number>(), processed = new Map<string, number>();
  const need = (id: string, level: number) => {
    if (id === 'root') return;
    if (level > (requested.get(id) ?? -1)) requested.set(id, level);
    if (requested.size > CONTEXT_LIMIT) throw tooLarge();
  };
  for (const id of [focus.id,...page.map(message=>message.id),...query.extraIds,...query.recordIds,...query.trace?.ids??[]]) need(id,body);
  if (category) need(category,body);
  // Levels only increase, so cycles terminate without a depth cutoff. Never
  // publish a truncated correction, stance or membership competition.
  for (;;) {
    const entries = [...requested].filter(([id,level])=>level > (processed.get(id) ?? -1));
    if (!entries.length) break;
    const batch = entries.map(([id])=>id), fresh = batch.filter(id=>!processed.has(id));
    for (const [id,level] of entries) processed.set(id,level);
    const loaded = await store.db.prepare('SELECT body FROM messages WHERE id=ANY($1::text[])').all(fresh);
    for (const row of loaded) { const message = JSON.parse(String(row.body)) as Message; records.set(message.id, message); }
    const inlineFrames: string[] = [], attachmentHosts: string[] = [];
    for (const [currentId,level] of entries) {
      const message = records.get(currentId); if (!message) continue;
      const primary = primaryRelation(message);
      if (level >= relation && (level === body || !containers.has(primary?.relation ?? ''))) attachmentHosts.push(currentId);
      // Classifications and summaries stay closed. Merge/arrange frames render
      // members only when displayed, not when supplied as ownership context.
      if (level === body && currentId !== category && ['merge', 'arrange'].includes(primary?.relation ?? '')) inlineFrames.push(currentId);
      if (!containers.has(primary?.relation ?? '')) for (const part of relations(message))
        if (level >= relation || effects.includes(part.relation) || part.relation === 'member-of')
          for (const binding of Object.values(part.roles).flat()) need(binding.reference.messageId,context);
      // An explicitly selected source-owned link presents that source's body.
      if (level === body && ['reference','reply','notify','annotation'].includes(primary?.relation ?? ''))
        for (const binding of primary?.roles.source ?? []) need(binding.reference.messageId,body);
      for (const part of message.parts) if (part.type === 'display' && part.target) need(part.target.messageId,context);
    }
    if (inlineFrames.length) {
      const members = await store.db.prepare('SELECT "memberId","sourceId" FROM memberships WHERE "parentId"=ANY($1::text[]) LIMIT $2').all(inlineFrames,CONTEXT_LIMIT + 1);
      for (const row of members) { need(String(row.memberId),body); need(String(row.sourceId),relation); }
    }
    const parents = await store.db.prepare('SELECT "parentId","sourceId" FROM memberships WHERE "memberId"=ANY($1::text[])').all(batch);
    for (const row of parents) { need(String(row.parentId),context); need(String(row.sourceId),relation); }
    // Executed stances retain their original target after edits. Current refs
    // alone can miss those decisions. A body's automatic self stake does not
    // promote background context into an open discussion.
    const stances = await store.db.prepare(`SELECT "sourceId","targetId" FROM display_stances
      WHERE "sourceId"<>"targetId" AND ("targetId"=ANY($1::text[]) OR "sourceId"=ANY($1::text[]))
      LIMIT $2`).all(fresh,CONTEXT_LIMIT + 1);
    for (const row of stances) { need(String(row.sourceId),relation); need(String(row.targetId),context); }
    // JOIN edits preserve an executed membership history independently of the
    // current raw references. Include competitors/predecessors and their parents.
    const memberships = await store.db.prepare(`SELECT id,body FROM membership_actions
      WHERE id=ANY($1::text[]) OR body->>'memberId'=ANY($1::text[]) LIMIT $2`).all(batch,CONTEXT_LIMIT + 1);
    for (const row of memberships) {
      need(String(row.id),relation);
      const history = row.body as {memberId:string;parentId:string;previousId:string|null;previousParentId:string|null};
      need(history.memberId,context); need(history.parentId,context);
      if (history.previousId) need(history.previousId,relation);
      if (history.previousParentId) need(history.previousParentId,context);
    }
    // Ordinary pages need the source-owned links excluded from body paging.
    // Trace links were selected by direction above; adding others would widen it.
    // Parent-owned JOIN records must not open every member of a closed category.
    // refs also indexes placement, source and reason bindings. An effect only
    // affects its semantic targets, not every message mentioned in its parts.
    const affecting = await store.db.prepare(`SELECT DISTINCT m.id FROM refs r JOIN messages m ON m.id=r."sourceId"
      WHERE r."targetId"=ANY($1::text[]) AND (
        EXISTS(SELECT 1 FROM ${primaryRelationSql('m')} semantic,
          jsonb_array_elements(semantic.value #> '{roles,target}') binding
          WHERE semantic.value->>'relation' IN ('${effects.join("','")}')
            AND binding #>> '{reference,messageId}'=r."targetId")
        OR (${!query.trace} AND r."targetId"=ANY($3::text[])
          AND COALESCE(${primaryRelationSql('m')}->>'relation','') NOT IN ('member-of','join')
          AND NOT ${isSettlementRecordSql('m')} AND NOT ${isReviewDiscussionSql('m')}
          AND ${displayAttachmentSql('m', 'r."targetId"')})
        OR EXISTS(SELECT 1 FROM jsonb_array_elements(m.body::jsonb->'parts') part,
          jsonb_array_elements(part->'roles'->'member') binding WHERE part->>'relation'='member-of' AND binding #>> '{reference,messageId}'=r."targetId")
      ) LIMIT $2`).all<{id:string}>(batch, CONTEXT_LIMIT + 1, attachmentHosts);
    for (const row of affecting) need(row.id,relation);
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
    discussion: { focusId: focus.id, pageIds: page.map(message => message.id), nextCursor,
      recommendedPath: await recommendedClassificationPath(store, focus.id, userId),
      expandedIds: [...requested].filter(([id,level])=>level === body && records.has(id)).map(([id])=>id),
      cursor: Buffer.from(JSON.stringify(cursor)).toString('base64url'), memberCounts } };
}
