import { referenceKey, relations, type Message, type Reference } from '@gonglun/core';
import { DomainError, type Store } from './db.js';

/** Resolve value claims in batches, preserving each contract's original revision. */
export async function valueSubjects(store: Store, references: Reference[]): Promise<Map<string, Reference>> {
    const address = (reference: Reference) => JSON.stringify([reference.messageId, reference.revision ?? null]);
    const unique = [...new Map(references.map(reference => [address(reference), reference])).values()];
    const messages = new Map<string, Message>();
    for (let offset = 0; offset < unique.length; offset += 200) {
        const batch = unique.slice(offset, offset + 200);
        const rows = await store.db.prepare(`SELECT wanted.id,wanted.revision,
            CASE WHEN wanted.revision IS NULL THEN m.body ELSE r.body END AS body
            FROM unnest($1::text[],$2::integer[]) AS wanted(id,revision)
            LEFT JOIN messages m ON m.id=wanted.id
            LEFT JOIN revisions r ON r."messageId"=wanted.id AND r.revision=wanted.revision`)
            .all(batch.map(reference => reference.messageId), batch.map(reference => reference.revision ?? null));
        for (const row of rows) {
            if (!row.body) throw new DomainError('消息或版本不存在', 404);
            messages.set(JSON.stringify([row.id, row.revision]), JSON.parse(String(row.body)) as Message);
        }
    }
    return new Map(references.map(reference => {
        const claim = messages.get(address(reference))!;
        const subject = relations(claim).find(part => part.relation === 'open-value-settlement')?.roles.target?.[0]?.reference;
        return [referenceKey(reference), subject ?? reference];
    }));
}
