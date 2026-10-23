import { relations, targets, type Message } from '@gonglun/core';
import type { Store } from './db.js';

const families: Record<string, string> = { read: 'read', unread: 'read', follow: 'follow', block: 'block', recommend: 'archive', archive: 'archive', unarchive: 'archive' };
/** Personal actions execute once when a message is sent, independently of later edits. */
export async function recordPersonal(store: Store, message: Message) {
    if (message.authorId === 'system' || message.revision !== 1)
        return;
    const insert = store.db.prepare(`INSERT INTO personal_actions("authorId","targetId",family,action,sequence,"sourceId","partId","partOrder") VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT ("sourceId","partId","targetId") DO NOTHING`);
    const latest = store.db.prepare(`INSERT INTO personal_marks("authorId","targetId",family,action,sequence,"sourceId","partId","partOrder") VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT("authorId","targetId",family) DO UPDATE SET action=excluded.action,sequence=excluded.sequence,"sourceId"=excluded."sourceId","partId"=excluded."partId","partOrder"=excluded."partOrder"
    WHERE excluded.sequence>personal_marks.sequence OR (excluded.sequence=personal_marks.sequence AND (excluded."sourceId">personal_marks."sourceId" OR (excluded."sourceId"=personal_marks."sourceId" AND excluded."partOrder">personal_marks."partOrder")))`);
    for (const part of relations(message)) {
        if (part.relation === 'notify')
            for (const reference of targets(part, 'target')) {
                const recipients = await store.db.prepare(`SELECT "authorId" FROM personal_marks WHERE "targetId"=$1 AND family='follow' AND action='follow'`).all(reference.messageId);
                const original = await store.message(reference.messageId);
                if (original.authorId !== 'system')
                    recipients.push({ authorId: original.authorId });
                for (const recipient of recipients)
                    await store.db.prepare(`INSERT INTO notification_receipts("sourceId","userId","targetId") VALUES ($1,$2,$3) ON CONFLICT ("sourceId","userId","targetId") DO NOTHING`).run(message.id, String(recipient.authorId), reference.messageId);
            }
        const family = families[part.relation];
        if (!family)
            continue;
        const partOrder = message.parts.indexOf(part);
        for (const reference of targets(part, 'target')) {
            const action = (part.relation === 'follow' || part.relation === 'block') && part.reason === 'NO' ? `un${part.relation}` : part.relation;
            const values = [message.authorId, reference.messageId, family, action, message.sequence, message.id, part.id, partOrder] as const;
            if ((await insert.run(...values)).rowCount)
                await latest.run(...values);
        }
    }
}
export async function initializePersonal(store: Store) {
    await store.db.exec(`
        CREATE TABLE IF NOT EXISTS personal_actions(
            "authorId" TEXT NOT NULL, "targetId" TEXT NOT NULL, family TEXT NOT NULL,
            action TEXT NOT NULL, sequence BIGINT NOT NULL, "sourceId" TEXT NOT NULL,
            "partId" TEXT NOT NULL, "partOrder" INTEGER NOT NULL,
            PRIMARY KEY("sourceId", "partId", "targetId")
        );
        CREATE INDEX IF NOT EXISTS personal_action_owner
            ON personal_actions("authorId", "targetId", family, sequence);
        CREATE TABLE IF NOT EXISTS personal_marks(
            "authorId" TEXT NOT NULL, "targetId" TEXT NOT NULL, family TEXT NOT NULL,
            action TEXT NOT NULL, sequence BIGINT NOT NULL, "sourceId" TEXT NOT NULL,
            "partId" TEXT NOT NULL, "partOrder" INTEGER NOT NULL,
            PRIMARY KEY("authorId", "targetId", family)
        );
        CREATE INDEX IF NOT EXISTS personal_mark_filter
            ON personal_marks("authorId", family, action, "targetId");
    `);
}
