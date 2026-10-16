import { type Message, type Page } from '@gonglun/core';
import { DomainError, type Store } from './db.js';
import { pageFor } from './queries.js';
export interface PersonalMark {
    messageId: string;
    read: boolean;
    followed: boolean;
    blocked: boolean;
    archived: boolean;
}
export type PersonalPage = Page & {
    personalStates: PersonalMark[];
};
export type PersonalFilter = 'normal' | 'follow' | 'read' | 'unread' | 'block' | 'archive';
export interface PersonalQuery {
    parent?: string;
    cursor?: string;
    limit?: number;
    q?: string;
    relation?: string;
    author?: string;
    filter?: PersonalFilter;
    after?: number;
}
const marksCte = "WITH RECURSIVE latest AS (SELECT * FROM personal_marks WHERE \"authorId\"=$1)";
export async function personalMarks(store: Store, userId: string, ids: string[]): Promise<PersonalMark[]> {
    if (!ids.length)
        return [];
    if (ids.length > 100)
        throw new DomainError('一次最多查询 100 条消息');
    const rows = (await store.db.prepare(`${marksCte} SELECT "targetId",family,action FROM latest WHERE "targetId"=ANY($2::text[])`).all(userId, ids));
    const result = new Map(ids.map(messageId => [messageId, { messageId, read: false, followed: false, blocked: false, archived: false }]));
    for (const row of rows) {
        const value = result.get(String(row.targetId));
        if (!value)
            continue;
        if (row.family === 'read')
            value.read = row.action === 'read';
        if (row.family === 'follow')
            value.followed = row.action === 'follow';
        if (row.family === 'block')
            value.blocked = row.action === 'block';
        if (row.family === 'archive')
            value.archived = row.action === 'archive';
    }
    return [...result.values()];
}
export async function markedPage(store: Store, userId: string, ids: string[]): Promise<PersonalPage> {
    const unique = [...new Set(ids)];
    if (unique.length > 100)
        throw new DomainError('一次最多查询 100 条消息');
    const messages = unique.length ? (await store.db.prepare('SELECT body FROM messages WHERE id=ANY($1::text[])').all(unique)).map(row => JSON.parse(row.body as string) as Message) : [];
    return { ...(await pageFor(store, messages)), personalStates: (await personalMarks(store, userId, messages.map(message => message.id))) };
}
function filters(options: PersonalQuery, userId:string, notifications = false) {
    const clauses: string[] = [];
    const values: (string | number)[] = [userId];
    const parameter=(value:string|number)=>{values.push(value);return `$${values.length}`;};
    if (options.parent) {
        clauses.push(`EXISTS (SELECT 1 FROM memberships mm WHERE mm."memberId"=m.id AND mm."parentId"=${parameter(options.parent)})`);
    }
    else if (!notifications && !options.q && !options.author && !options.relation && (!options.filter || options.filter === 'normal'))
        clauses.push("NOT EXISTS (SELECT 1 FROM memberships mm WHERE mm.\"memberId\"=m.id)");
    if (options.cursor) {
        let cursor: {
            sequence: number;
            id: string;
        };
        try {
            cursor = JSON.parse(Buffer.from(options.cursor, 'base64url').toString('utf8'));
        }
        catch {
            throw new DomainError('分页游标无效');
        }
        if (!Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0 || typeof cursor.id !== 'string' || cursor.id.length > 100)
            throw new DomainError('分页游标无效');
        const sequence=parameter(cursor.sequence),id=parameter(cursor.id);
        clauses.push(`(m.sequence<${sequence} OR (m.sequence=${sequence} AND m.id<${id}))`);
    }
    if (options.after !== undefined) {
        if (!Number.isSafeInteger(options.after) || options.after < 0)
            throw new DomainError('变更游标无效');
        clauses.push(`m.sequence>${parameter(options.after)}`);
    }
    if (options.q) {
        const search=parameter(`%${options.q.replace(/[\\%_]/g, '\\$&')}%`);
        clauses.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(m.body::jsonb -> 'parts') p WHERE p.value->>'text' ILIKE ${search} ESCAPE '\\' OR p.value->>'source' ILIKE ${search} ESCAPE '\\' OR p.value->>'excerpt' ILIKE ${search} ESCAPE '\\')`);
    }
    if (options.relation) {
        clauses.push(`EXISTS (SELECT 1 FROM jsonb_array_elements(m.body::jsonb -> 'parts') p WHERE p.value->>'relation'=${parameter(options.relation)})`);
    }
    if (options.author) {
        clauses.push(`m."authorId"=${parameter(options.author)}`);
    }
    return { clauses, values, parameter };
}
async function response(store: Store, userId: string, rows: Record<string, unknown>[], limit: number): Promise<PersonalPage> {
    const messages = rows.slice(0, limit).map(row => JSON.parse(row.body as string) as Message);
    const last = messages.at(-1);
    const nextCursor = rows.length > limit && last ? Buffer.from(JSON.stringify({ sequence: last.sequence, id: last.id })).toString('base64url') : null;
    return { ...(await pageFor(store, messages, nextCursor)), personalStates: (await personalMarks(store, userId, messages.map(message => message.id))) };
}
export async function personalMessages(store: Store, userId: string, options: PersonalQuery): Promise<PersonalPage> {
    const { clauses, values, parameter } = filters(options,userId);
    const filter = options.filter || 'normal';
    if (filter === 'normal')
        clauses.push("NOT EXISTS (SELECT 1 FROM latest WHERE \"targetId\"=m.id AND family='block' AND action='block')");
    else if (filter === 'unread')
        clauses.push("NOT EXISTS (SELECT 1 FROM latest WHERE \"targetId\"=m.id AND family='read' AND action='read')");
    else {
        const mark=parameter(filter);
        clauses.push(`EXISTS (SELECT 1 FROM latest WHERE "targetId"=m.id AND family=${mark} AND action=${mark})`);
    }
    const limit = Math.min(100, Math.max(1, options.limit || 30));
    const bound=parameter(limit+1);
    const rows = (await store.db.prepare(`${marksCte} SELECT m.body FROM messages m WHERE ${clauses.join(' AND ')} ORDER BY m.sequence DESC,m.id DESC LIMIT ${bound}`).all(...values));
    return (await response(store, userId, rows, limit));
}
export async function notifications(store: Store, userId: string, options: PersonalQuery): Promise<PersonalPage> {
    const { clauses, values, parameter } = filters(options,userId,true);
    const limit = Math.min(100, Math.max(1, options.limit || 30));
    const sql = `${marksCte}, watched(id,since) AS (
    SELECT "targetId",sequence FROM latest WHERE family='follow' AND action='follow'
    UNION SELECT mm."memberId",w.since FROM memberships mm JOIN watched w ON mm."parentId"=w.id
  ) SELECT m.body FROM messages m WHERE m."authorId"<>$1 AND (
    EXISTS (SELECT 1 FROM notification_receipts nr WHERE nr."sourceId"=m.id AND nr."userId"=$1) OR
    EXISTS (SELECT 1 FROM refs r JOIN watched w ON r."targetId"=w.id WHERE r."sourceId"=m.id AND m.sequence>w.since)
    OR EXISTS (SELECT 1 FROM refs r JOIN messages original ON original.id=r."targetId" WHERE r."sourceId"=m.id AND original."authorId"=$1
      AND EXISTS(SELECT 1 FROM jsonb_array_elements(m.body::jsonb->'parts') p,jsonb_array_elements(p.value #> '{roles,target}') b WHERE p.value->>'relation'='notify' AND b.value #>> '{reference,messageId}'=original.id))
  ) AND NOT EXISTS (SELECT 1 FROM latest WHERE "targetId"=m.id AND family='block' AND action='block')
  ${clauses.length ? `AND ${clauses.join(' AND ')}` : ''} ORDER BY m.sequence DESC,m.id DESC LIMIT ${parameter(limit+1)}`;
    return (await response(store, userId, (await store.db.prepare(sql).all(...values)), limit));
}
