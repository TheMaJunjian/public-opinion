import { hasModeratedContent, hasReviewContext, messageDisplayDependency, relationLabelPart, relations, textOf, type Message } from '@gonglun/core';
import type { Store } from './db.js';

const labels: Record<string, string> = { classify: '分类', summary: '总结', proposal: '提案', 'rule-change': '提案', operations: '公告', delegate: '委托', release: '代码' };

export function feedEntry(message: Message) {
  const actions = relations(message);
  const primary = actions.find(part => !(part.relation === 'member-of' && !part.roles.member?.length)
    && !((part.id === 'self-stance' || part.id.startsWith('minimum-self-stance-')) && ['agree', 'disagree'].includes(part.relation)
      && part.roles.target?.length === 1 && part.roles.target[0]!.reference.messageId === message.id));
  // Only content types belong in discovery, even when a relation record has authored text.
  if (message.authorId === 'system' || hasReviewContext(message) || primary && !Object.hasOwn(labels, primary.relation) || relationLabelPart(message.parts)) return null;
  const data = Object.assign({}, ...message.parts.flatMap(part => part.type === 'data' && part.value && typeof part.value === 'object' && !Array.isArray(part.value) ? [part.value] : []));
  if (!hasModeratedContent(message, actions, data)) return null;
  const savedText = (value: unknown) => typeof value === 'string' ? value.trim() : '';
  // Old organization records store their card text in data alongside a generated body.
  // Test each part without payload text so a saved title cannot make that description readable.
  const body = textOf({ ...message, parts: message.parts.filter(part => hasModeratedContent({ parts: [part] }, actions, {})) });
  const content = primary && ['classify', 'summary'].includes(primary.relation)
    ? savedText(data.title) || savedText(data.content) || body
    : body || savedText(data.content) || savedText(data.title);
  const excerpt = content.replace(/\s+/g, ' ').trim().slice(0, 420);
  if (!excerpt) return null;
  return { id: message.id, authorId: message.authorId, revision: message.revision, sequence: message.sequence,
    createdAt: message.createdAt, updatedAt: message.updatedAt, excerpt,
    kind: primary ? labels[primary.relation] ?? '讨论' : message.parts.some(part => part.type === 'web') ? '网页' : message.parts.some(part => part.type === 'code') ? '代码' : '讨论',
    contextId: messageDisplayDependency(message)?.find(ref => ref.messageId !== message.id)?.messageId ?? null };
}

/** The transaction which publishes content also refreshes its bounded preview. */
export async function indexFeedMessages(store: Store, messages: Message[]) {
  if (!messages.length) return;
  // Historical upgrades can execute messages before the complete index exists.
  // Its migration backfills both tables once their schema is ready.
  const schema = await store.db.prepare("SELECT to_regclass('feed_entries') AS entries,to_regclass('feed_corrections') AS corrections").get();
  if (!schema?.entries || !schema.corrections) return;
  for (let offset = 0; offset < messages.length; offset += 250) {
    const batch = messages.slice(offset, offset + 250), entries = batch.flatMap(message => { const entry = feedEntry(message); return entry ? [entry] : []; });
    await store.db.prepare('DELETE FROM feed_corrections WHERE "sourceId"=ANY($1::text[])').run(batch.map(message => message.id));
    const corrections = batch.flatMap(message => relations(message).filter(part => ['amend', 'correct'].includes(part.relation))
      .flatMap(part => (part.roles.target ?? []).map(binding => ({ sourceId: message.id, targetId: binding.reference.messageId }))));
    if (corrections.length) await store.db.prepare(`INSERT INTO feed_corrections
      SELECT "sourceId","targetId" FROM jsonb_to_recordset($1::jsonb) AS c("sourceId" text,"targetId" text) ON CONFLICT DO NOTHING`).run(JSON.stringify(corrections));
    const present = new Set(entries.map(entry => entry.id));
    const removed = batch.filter(message => !present.has(message.id)).map(message => message.id);
    if (removed.length) await store.db.prepare('DELETE FROM feed_entries WHERE id=ANY($1::text[])').run(removed);
    if (entries.length) await store.db.prepare(`INSERT INTO feed_entries
      SELECT id,"authorId",revision,sequence,"createdAt","updatedAt",kind,excerpt,"contextId"
      FROM jsonb_to_recordset($1::jsonb) AS e(id text,"authorId" text,revision integer,sequence bigint,"createdAt" text,"updatedAt" text,kind text,excerpt text,"contextId" text)
      ON CONFLICT(id) DO UPDATE SET "authorId"=excluded."authorId",revision=excluded.revision,sequence=excluded.sequence,
        "updatedAt"=excluded."updatedAt",kind=excluded.kind,excerpt=excluded.excerpt,"contextId"=excluded."contextId"`)
      .run(JSON.stringify(entries));
  }
}
