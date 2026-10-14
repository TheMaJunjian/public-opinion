import { organization, referenceKey, relations, type Message, type MessageState, type Reference } from '@gonglun/core';
import type { Store } from './db.js';

/** Execution-time statements survive edits to their source messages and bounded views. */
export function initializeProjections(store: Store): void {
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS display_stances (
      sourceId TEXT PRIMARY KEY,
      authorId TEXT NOT NULL,
      targetId TEXT NOT NULL,
      targetRevision INTEGER NOT NULL,
      targetKey TEXT NOT NULL,
      targetPartId TEXT,
      wholeComponent INTEGER NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('pro', 'con')),
      sequence INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS display_stances_target
      ON display_stances(targetId, targetRevision, authorId, targetKey, sequence DESC, sourceId DESC);
  `);
}

/** The caller resolves the complete historical stance chain before executing this once. */
export function recordStance(
  store: Store,
  source: Message,
  resolved: { target: Reference; side: 'pro' | 'con' },
): string {
  const target: Reference = {
    ...resolved.target,
    revision: resolved.target.revision ?? store.message(resolved.target.messageId).revision,
  };
  const wholeComponent = !target.memberId && !target.path?.length && !target.range;
  store.db.prepare(`
    INSERT OR IGNORE INTO display_stances
      (sourceId, authorId, targetId, targetRevision, targetKey, targetPartId, wholeComponent, side, sequence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    source.id,
    source.authorId,
    target.messageId,
    target.revision!,
    referenceKey(target),
    target.partId ?? null,
    wholeComponent ? 1 : 0,
    resolved.side,
    source.sequence || store.latestSequence() + 1,
  );
  return target.messageId;
}

interface StanceRow {
  targetId: string;
  targetPartId: string | null;
  wholeComponent: number;
  side: 'pro' | 'con';
}

/** Authoritative display state is independent of which relation messages a page includes. */
export function statesFor(store: Store, ids: string[]): MessageState[] {
  const uniqueIds = [...new Set(ids)];
  const result: MessageState[] = [];
  // Keep SQLite parameter lists bounded even when a mutation touches many messages.
  for (let offset = 0; offset < uniqueIds.length; offset += 200) {
    const batch = uniqueIds.slice(offset, offset + 200);
    const placeholders = batch.map(() => '?').join(',');
    const messages = store.db.prepare(`SELECT body FROM messages WHERE id IN (${placeholders})`)
      .all(...batch).map(row => JSON.parse(String(row.body)) as Message);
    const byId = new Map(messages.map(message => [message.id, message]));
    const states = new Map<string, MessageState>(messages.map(message => [message.id, {
      messageId: message.id,
      revision: message.revision,
      suppressed: false,
      supportCount: 0,
      oppositionCount: 0,
      recommendationTotal: message.spending.recommendation,
    }]));

    // A stance executes only on send. Return that original basis even when its
    // source has subsequently been edited; clients can label the older revision.
    // One lookup per bounded batch avoids querying each visible source separately.
    const executions = store.db.prepare(`
      SELECT sourceId,revision,partId,target,side FROM execution_stances
      WHERE sourceId IN (${placeholders}) AND revision=1
      ORDER BY sourceId,partId
    `).all(...batch);
    for (const execution of executions) {
      const state = states.get(String(execution.sourceId));
      if (!state || state.executedStance) continue;
      state.executedStance = {
        partId: String(execution.partId),
        sourceRevision: Number(execution.revision),
        target: JSON.parse(String(execution.target)) as Reference,
        side: execution.side as 'pro' | 'con',
      };
    }

    const stances = store.db.prepare(`
      SELECT targetId, targetPartId, wholeComponent, side FROM (
        SELECT stance.*, ROW_NUMBER() OVER (
          PARTITION BY stance.authorId, stance.targetKey
          ORDER BY stance.sequence DESC, stance.sourceId DESC
        ) AS position
        FROM display_stances stance
        JOIN messages target ON target.id = stance.targetId
        WHERE stance.targetId IN (${placeholders})
          AND stance.targetRevision = json_extract(target.body, '$.revision')
      ) WHERE position = 1
    `).all(...batch) as unknown as StanceRow[];

    for (const stance of stances) {
      const state = states.get(stance.targetId);
      const message = byId.get(stance.targetId);
      if (!state || !message) continue;
      if (stance.side === 'pro') state.supportCount++;
      else state.oppositionCount++;
      const group = organization(message);
      if (stance.side === 'con' && stance.wholeComponent && group
        && (stance.targetPartId === null || stance.targetPartId === group.id)) state.suppressed = true;
    }

    const recommendations = store.db.prepare(`
      SELECT DISTINCT source.id, source.body FROM refs
      JOIN messages source ON source.id = refs.sourceId
      WHERE refs.targetId IN (${placeholders})
        AND json_extract(source.body, '$.spending.recommendation') > 0
    `).all(...batch);
    for (const row of recommendations) {
      const source = JSON.parse(String(row.body)) as Message;
      const recommended = new Set(relations(source)
        .filter(part => part.relation === 'recommend')
        .flatMap(part => (part.roles.target ?? []).map(binding => binding.reference))
        .filter(reference => reference.revision === undefined || reference.revision === byId.get(reference.messageId)?.revision)
        .map(reference => reference.messageId));
      for (const targetId of recommended) {
        const state = states.get(targetId);
        // A self-reference must not count the sender's own recommendation spend twice.
        if (state && targetId !== source.id) state.recommendationTotal += source.spending.recommendation;
      }
    }
    result.push(...batch.flatMap(messageId => states.has(messageId) ? [states.get(messageId)!] : []));
  }
  return result;
}
