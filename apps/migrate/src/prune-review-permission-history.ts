import type { Change, Message } from '@gonglun/core';
import type { Store } from '../../server/src/db.js';

/** An accounting record still needs the original message identity, revision and spending. */
function pruneChange(change: Change, obsolete: Set<string>, keepForLedger: Set<string>): Change {
  const messages: Message[] = [];
  for (const message of change.messages) {
    if (!obsolete.has(message.id)) messages.push(message);
    else if (keepForLedger.has(message.id)) messages.push({ ...message, parts: [] });
  }
  const memberships = change.memberships.filter(row =>
    !obsolete.has(row.memberId) && !obsolete.has(row.parentId) && !obsolete.has(row.sourceId));
  const states = change.states.filter(state => !obsolete.has(state.messageId));
  const usageRewardTotals = change.usageRewardTotals?.filter(row => !obsolete.has(row.messageId));
  return { ...change, messages, memberships, states, ...(usageRewardTotals && { usageRewardTotals }) };
}

/** The caller adds the returned IDs to the same removal event that invalidates existing caches. */
export async function pruneReviewPermissionHistory(store: Store, obsoleteIds: string[]): Promise<string[]> {
  if (!obsoleteIds.length) return [];
  const obsolete = new Set(obsoleteIds);
  const funded = await store.db.prepare(`SELECT DISTINCT entry->>'messageId' AS id
    FROM changes CROSS JOIN LATERAL jsonb_array_elements(body::jsonb->'ledger') entry
    WHERE entry->>'messageId'=ANY($1::text[])`).all<{id:string}>(obsoleteIds);
  const keepForLedger = new Set(funded.map(row => row.id));
  let sequence = 0;
  for (;;) {
    const rows = await store.db.prepare('SELECT sequence,body FROM changes WHERE sequence>$1 ORDER BY sequence LIMIT 100')
      .all<{sequence:number;body:string}>(sequence);
    if (!rows.length) break;
    for (const row of rows) {
      sequence = row.sequence;
      const change = JSON.parse(row.body) as Change;
      const updated = JSON.stringify(pruneChange(change, obsolete, keepForLedger));
      if (updated !== JSON.stringify(change))
        await store.db.prepare('UPDATE changes SET body=$2 WHERE sequence=$1').run(sequence, updated);
    }
  }
  return obsoleteIds.filter(id => !keepForLedger.has(id));
}
