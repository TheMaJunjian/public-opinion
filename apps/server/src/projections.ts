import { organization, referenceKey, relations, type Message, type MessageState, type Reference } from '@gonglun/core';
import type { Store } from './db.js';
/** Execution-time statements survive edits to their source messages and bounded views. */
export async function initializeProjections(store: Store): Promise<void> {
    await store.db.exec(`
        CREATE TABLE IF NOT EXISTS display_stances (
            "sourceId" TEXT PRIMARY KEY,
            "authorId" TEXT NOT NULL,
            "targetId" TEXT NOT NULL,
            "targetRevision" INTEGER NOT NULL,
            "targetKey" TEXT NOT NULL,
            "targetPartId" TEXT,
            "wholeComponent" INTEGER NOT NULL,
            side TEXT NOT NULL CHECK (side IN ('pro', 'con')),
            sequence BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS display_stances_target
            ON display_stances("targetId", "targetRevision", "authorId", "targetKey", sequence DESC, "sourceId" DESC);
    `);
}
/** The caller resolves the complete historical stance chain before executing this once. */
export async function recordStance(store: Store, source: Message, resolved: {
    target: Reference;
    side: 'pro' | 'con';
}): Promise<string> {
    const target: Reference = {
        ...resolved.target,
        revision: resolved.target.revision ?? (await store.message(resolved.target.messageId)).revision,
    };
    const wholeComponent = !target.memberId && !target.path?.length && !target.range;
    await store.db.prepare(`
        INSERT INTO display_stances
            ("sourceId", "authorId", "targetId", "targetRevision", "targetKey", "targetPartId", "wholeComponent", side, sequence)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT ("sourceId") DO NOTHING
    `).run(source.id, source.authorId, target.messageId, target.revision!, referenceKey(target), target.partId ?? null, wholeComponent ? 1 : 0, resolved.side, source.sequence || (await store.latestSequence()) + 1);
    if(!source.parts.some(part=>part.type==='data'&&part.value&&typeof part.value==='object'&&!Array.isArray(part.value)&&'legacyTopicId' in part.value)) await store.db.prepare('UPDATE legacy_organization_states SET body=body || \'{"nativeOverride":true}\'::jsonb WHERE "messageId"=$1').run(target.messageId);
    return target.messageId;
}

interface StanceRow {
  targetId: string;
  targetPartId: string | null;
  wholeComponent: number;
  side: 'pro' | 'con';
}
/** Authoritative display state is independent of which relation messages a page includes. */
export async function statesFor(store: Store, ids: string[]): Promise<MessageState[]> {
    const uniqueIds = [...new Set(ids)];
    const result: MessageState[] = [];
    // Keep query results bounded even when a mutation touches many messages.
    for (let offset = 0; offset < uniqueIds.length; offset += 200) {
        const batch = uniqueIds.slice(offset, offset + 200);
        const placeholders = batch.map((_, index) => `$${index + 1}`).join(',');
        const messages = (await store.db.prepare(`SELECT body FROM messages WHERE id IN (${placeholders})`)
            .all(...batch)).map(row => JSON.parse(String(row.body)) as Message);
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
        const executions = await store.db.prepare(`
      SELECT "sourceId",revision,"partId",target,side FROM execution_stances
      WHERE "sourceId" IN (${placeholders}) AND revision=1
      ORDER BY "sourceId","partId"
    `).all(...batch);
        for (const execution of executions) {
            const state = states.get(String(execution.sourceId));
            if (!state || state.executedStance)
                continue;
            state.executedStance = {
                partId: String(execution.partId),
                sourceRevision: Number(execution.revision),
                target: JSON.parse(String(execution.target)) as Reference,
                side: execution.side as 'pro' | 'con',
            };
        }
        const stances = (await store.db.prepare(`
      SELECT "targetId", "targetPartId", "wholeComponent", side FROM (
        SELECT stance.*, ROW_NUMBER() OVER (
          PARTITION BY stance."authorId", stance."targetKey"
          ORDER BY stance.sequence DESC, stance."sourceId" DESC
        ) AS position
        FROM display_stances stance
        JOIN messages target ON target.id = stance."targetId"
        WHERE stance."targetId" IN (${placeholders})
          AND stance."targetRevision" = (target.body::jsonb #>> '{revision}')::integer
      ) ranked WHERE position = 1
    `).all(...batch)) as unknown as StanceRow[];
        for (const stance of stances) {
            const state = states.get(stance.targetId);
            const message = byId.get(stance.targetId);
            if (!state || !message)
                continue;
            if (stance.side === 'pro')
                state.supportCount++;
            else
                state.oppositionCount++;
            const group = organization(message) ?? relations(message).find(part => part.relation === 'member-of' && part.roles.member?.length);
            if (stance.side === 'con' && stance.wholeComponent && group
                && (stance.targetPartId === null || stance.targetPartId === group.id))
                state.suppressed = true;
        }
        const recommendations = await store.db.prepare(`
      SELECT DISTINCT source.id, source.body FROM refs
      JOIN messages source ON source.id = refs."sourceId"
      WHERE refs."targetId" IN (${placeholders})
        AND (source.body::jsonb #>> '{spending,recommendation}')::bigint > 0
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
                if (state && targetId !== source.id)
                    state.recommendationTotal += source.spending.recommendation;
            }
        }
        const imported=await store.db.prepare('SELECT "messageId",body FROM legacy_organization_states WHERE "messageId"=ANY($1::text[])').all(batch);
        for(const row of imported) {
            const state=states.get(String(row.messageId));
            if(!state) continue;
            if(row.body.nativeOverride) continue;
            state.supportCount=row.body.agreeCount??0;
            state.oppositionCount=row.body.disagreeCount??0;
            state.suppressed=!!row.body.rejected;
        }
        const placements = await store.db.prepare(`SELECT a.id,a.disabled,m."sourceId" FROM membership_actions a
            LEFT JOIN memberships m ON m."memberId"=a.body->>'memberId' WHERE a.id=ANY($1::text[])`).all(batch);
        for (const row of placements) {
            const state = states.get(String(row.id));
            if (state) { state.membershipActive = row.sourceId === row.id; if (row.disabled) state.suppressed = true; }
        }
        result.push(...batch.flatMap(messageId => states.has(messageId) ? [states.get(messageId)!] : []));
    }
    return result;
}
