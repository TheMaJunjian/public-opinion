import type { Context, Membership, Message, Page, User } from '@gonglun/core';
import { DomainError, Store } from './db.js';
import { roundsFor } from './economy.js';
import { statesFor } from './projections.js';
const decode = (row: Record<string, unknown>) => JSON.parse(row.body as string) as Message;
function cursorValue(cursor: string | undefined): {
    sequence: number;
    id: string;
} | undefined {
    if (!cursor)
        return;
    try {
        const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
            sequence: number;
            id: string;
        };
        if (!Number.isSafeInteger(parsed.sequence) || parsed.sequence < 0 || typeof parsed.id !== 'string' || parsed.id.length > 100)
            throw new Error();
        return parsed;
    }
    catch {
        throw new DomainError('分页游标无效');
    }
}
export async function pageFor(store: Store, messages: Message[], nextCursor: string | null = null): Promise<Page> {
    const authorIds = [...new Set(messages.map(m => m.authorId))];
    const users: User[] = (await Promise.all(authorIds.map(async (userId) => userId === 'system' ? { id: 'system', name: '公论规则', founder: false } : (await store.user(userId)))));
    const ids = messages.map(m => m.id);
    const memberships = ids.length ? (await store.db.prepare('SELECT "memberId","parentId","sourceId","sourcePartId","bindingId","sourceRevision" FROM memberships WHERE "memberId"=ANY($1::text[])').all(ids)) as unknown as Membership[] : [];
    return { messages, users, memberships, nextCursor, sequence: (await store.latestSequence()), states: (await statesFor(store, ids)) };
}
export async function listMessages(store: Store, options: {
    parent?: string;
    cursor?: string;
    limit?: number;
    q?: string;
    relation?: string;
    author?: string;
}): Promise<Page> {
    const limit = Math.max(1, Math.min(100, options.limit ?? 30)), clauses: string[] = [], params: (string | number)[] = [];
    const parameter=(value:string|number)=>{params.push(value);return `$${params.length}`;};
    if (options.parent) {
        (await store.message(options.parent));
        clauses.push(`EXISTS (SELECT 1 FROM memberships m WHERE m."memberId"=messages.id AND m."parentId"=${parameter(options.parent)})`);
    }
    else if (!options.q && !options.author && !options.relation)
        clauses.push("NOT EXISTS (SELECT 1 FROM memberships m WHERE m.\"memberId\"=messages.id)");
    const cursor = cursorValue(options.cursor);
    if (cursor) {
        const sequence=parameter(cursor.sequence),id=parameter(cursor.id);
        clauses.push(`(sequence<${sequence} OR (sequence=${sequence} AND id<${id}))`);
    }
    if (options.q) {
        const query = `%${options.q.replace(/[\\%_]/g, '\\$&')}%`;
        const search=parameter(query);
        clauses.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(messages.body::jsonb -> 'parts') p WHERE p.value->>'text' ILIKE ${search} ESCAPE '\\' OR p.value->>'source' ILIKE ${search} ESCAPE '\\' OR p.value->>'excerpt' ILIKE ${search} ESCAPE '\\')`);
    }
    if (options.relation) {
        clauses.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(messages.body::jsonb -> 'parts') p WHERE p.value->>'relation'=${parameter(options.relation)})`);
    }
    if (options.author) {
        clauses.push(`"authorId"=${parameter(options.author)}`);
    }
    const bound=parameter(limit+1);
    const rows = (await store.db.prepare(`SELECT body FROM messages WHERE ${clauses.join(' AND ')||'TRUE'} ORDER BY sequence DESC,id DESC LIMIT ${bound}`).all(...params));
    const messages = rows.slice(0, limit).map(decode), last = messages.at(-1);
    return (await pageFor(store, messages, rows.length > limit && last ? Buffer.from(JSON.stringify({ sequence: last.sequence, id: last.id })).toString('base64url') : null));
}
export async function context(store: Store, messageId: string): Promise<Context> {
    const target = (await store.message(messageId));
    const children = (await listMessages(store, { parent: messageId, limit: 50 }));
    const related = (await store.db.prepare("SELECT body FROM messages WHERE id IN (\n    SELECT \"sourceId\" FROM refs WHERE \"targetId\"=$1 UNION SELECT \"targetId\" FROM refs WHERE \"sourceId\"=$2\n  ) ORDER BY sequence DESC,id DESC LIMIT 100").all(messageId, messageId)).map(decode);
    const unique = [...new Map([target, ...children.messages, ...related].map(m => [m.id, m])).values()];
    return { ...(await pageFor(store, unique, children.nextCursor)), rounds: (await roundsFor(store, messageId)) };
}
export async function changes(store: Store, after: number, limit = 100) {
    if (!Number.isSafeInteger(after) || after < 0)
        throw new DomainError('变更游标无效');
    const rows = (await store.db.prepare("SELECT sequence,body FROM changes WHERE sequence>$1 ORDER BY sequence LIMIT $2").all(after, limit + 1));
    const selected = rows.slice(0, limit);
    return { changes: selected.map(r => JSON.parse(r.body as string)), nextCursor: selected.length ? Number(selected.at(-1)!.sequence) : after, hasMore: rows.length > limit };
}
