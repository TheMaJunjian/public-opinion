import { rejectsMembership, resolveRecommendedMemberships, type MembershipAction, type Message } from '@gonglun/core';
import type { Store } from './db.js';
import { retiredOrganizationIds } from './retired-organizations.js';
import { inaccessibleMessages } from './moderation-visibility.js';
import { feedEntry } from './feed-index.js';
export { recommendedMembershipSchema } from './feed-schema.js';

/** Derived public display only. Never rewrites protocol placements, votes or personal choices. */
export async function indexRecommendedMemberships(store: Store, affected?: ReadonlySet<string>) {
  if (!(await store.db.prepare("SELECT to_regclass('recommended_memberships') AS name").get())?.name) return;
  if (affected && (!affected.size || !await store.db.prepare(`SELECT 1 FROM membership_actions
    WHERE id=ANY($1::text[]) OR body->>'parentId'=ANY($1::text[]) OR body->>'memberId'=ANY($1::text[]) LIMIT 1`).get([...affected]))) return;
  const rows = await store.db.prepare(`SELECT a.body,a.disabled,m.sequence,m.body::jsonb->>'createdAt' AS "createdAt"
    FROM membership_actions a JOIN messages m ON m.id=a.id ORDER BY a.position`).all();
  const actions = rows.map(row => ({ ...(row.body as MembershipAction), disabled: !!row.disabled,
    sequence: Number(row.sequence), createdAt: String(row.createdAt) }));
  const ids = [...new Set(actions.flatMap(action => [action.id, action.parentId]))];
  const totals = await store.db.prepare(`SELECT "subjectId" AS id,
    COALESCE(SUM(amount) FILTER(WHERE side='pro'),0) AS pro, COALESCE(SUM(amount) FILTER(WHERE side='con'),0) AS con
    FROM stake_positions WHERE "subjectId"=ANY($1::text[]) GROUP BY "subjectId"`).all(ids);
  const scores = new Map(totals.map(row => [String(row.id), { pro: Number(row.pro), con: Number(row.con) }]));
  const stances = await store.db.prepare(`SELECT DISTINCT ON (s."targetId") s."targetId",s.side
    FROM display_stances s JOIN messages m ON m.id=s."sourceId" JOIN messages target ON target.id=s."targetId"
    WHERE s."targetId"=ANY($1::text[]) AND s."wholeComponent"=1 AND s."targetPartId" IS NULL
      AND s."targetRevision"=(target.body::jsonb->>'revision')::integer
    ORDER BY s."targetId",m.body::jsonb->>'createdAt' DESC,m.sequence DESC,s."sourceId" DESC`).all(ids);
  const latest = new Map(stances.map(row => [String(row.targetId), row.side === 'pro' ? 'agree' as const : 'disagree' as const]));
  const excluded = await retiredOrganizationIds(store), unavailableMembers = new Set(excluded);
  for (const id of ids) {
    const score = scores.get(id) ?? { pro: 0, con: 0 };
    if (rejectsMembership(score.pro, score.con, latest.get(id))) excluded.add(id);
  }
  for (const action of actions) if (action.disabled) excluded.add(action.id);
  if ((await store.rules()).moderation?.enabled) {
    const rejected = await store.db.prepare(`SELECT "messageId" FROM (
      SELECT DISTINCT ON ("messageId") "messageId",status FROM moderation_cases ORDER BY "messageId",revision DESC
    ) latest WHERE status IN ('rejected','appeal')`).all();
    for (const row of rejected) { excluded.add(String(row.messageId)); unavailableMembers.add(String(row.messageId)); }
  }
  const memberships = [...resolveRecommendedMemberships(actions.filter(action => !unavailableMembers.has(action.memberId))
    .map(action => ({ ...action, support: scores.get(action.id)?.pro ?? 0 })), excluded).values()];
  await store.db.prepare('DELETE FROM recommended_memberships WHERE NOT ("memberId"=ANY($1::text[]))').run(memberships.map(value => value.memberId));
  for (let offset = 0; offset < memberships.length; offset += 500) {
    await store.db.prepare(`INSERT INTO recommended_memberships SELECT * FROM jsonb_to_recordset($1::jsonb)
      AS row("memberId" text,"parentId" text,"sourceId" text)
      ON CONFLICT ("memberId") DO UPDATE SET "parentId"=EXCLUDED."parentId","sourceId"=EXCLUDED."sourceId"
      WHERE (recommended_memberships."parentId",recommended_memberships."sourceId") IS DISTINCT FROM (EXCLUDED."parentId",EXCLUDED."sourceId")`)
      .run(JSON.stringify(memberships.slice(offset, offset + 500)));
  }
}

/** Parent first, root last. A visited path guards against a damaged cyclic index. */
export async function recommendedAncestors(store: Store, ids: string[]): Promise<Map<string, string[]>> {
  if (!ids.length) return new Map();
  const rows = await store.db.prepare(`WITH RECURSIVE paths(id,parent,path) AS (
    SELECT "memberId","parentId",ARRAY["memberId","parentId"] FROM recommended_memberships WHERE "memberId"=ANY($1::text[])
    UNION ALL SELECT p.id,m."parentId",p.path||m."parentId" FROM paths p JOIN recommended_memberships m ON m."memberId"=p.parent
      WHERE NOT m."parentId"=ANY(p.path)
  ) SELECT DISTINCT ON (id) id,path FROM paths ORDER BY id,cardinality(path) DESC`).all<{ id: string; path: string[] }>(ids);
  return new Map(rows.map(row => [row.id, row.path.slice(1)]));
}

export async function recommendedClassificationPath(store: Store, id: string, userId: string) {
  const ids = ((await recommendedAncestors(store, [id])).get(id) ?? []).reverse();
  if (!ids.length) return [];
  const blocked = await inaccessibleMessages(store, ids, userId);
  const rows = await store.db.prepare('SELECT id,body FROM messages WHERE id=ANY($1::text[])').all(ids);
  const byId = new Map(rows.map(row => [String(row.id), JSON.parse(String(row.body)) as Message]));
  return ids.map(id => {
    const message = byId.get(id);
    if (!message || blocked.has(id)) return { id: '', title: '不可查看的分类' };
    const data = message.parts.filter(part => part.type === 'data').map(part => part.value).filter(value => value && typeof value === 'object') as Record<string, unknown>[];
    const title = data.map(value => value.title).find(value => typeof value === 'string' && value.trim());
    return { id, title: String(feedEntry(message)?.excerpt || title || '分类').replace(/\s+/g, ' ').slice(0, 100) };
  });
}
