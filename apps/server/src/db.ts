import { randomUUID } from 'node:crypto';
import { type Account, type Change, type LedgerEntry, type Membership, type Message, type Rules, type User } from '@gonglun/core';
import { statesFor } from './projections.js';
import { Postgres } from './postgres.js';
import { migrationsFor, runMigrations } from './migrations.js';

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export class DomainError extends Error { constructor(message: string, public status = 400) { super(message); } }
export function integer(value: number, label = '金额'): number {
  if (!Number.isSafeInteger(value)) throw new DomainError(`${label}超出安全整数范围`);
  return value;
}

export class Store {
  private constructor(readonly db: Postgres) {}

  /** Inspect an existing database in one enforced read-only snapshot, without startup upgrades. */
  static async inspect<T>(databaseUrl: string, options: { schema?: string }, read: (store: Store) => T | Promise<T>): Promise<T> {
    const store = new Store(new Postgres(databaseUrl, options.schema));
    try { return await store.read(() => read(store)); }
    finally { await store.close(); }
  }

  static async open(databaseUrl: string, options: { schema?: string } = {}): Promise<Store> {
    const store = new Store(new Postgres(databaseUrl, options.schema));
    try {
      await store.transaction(async () => {
        await store.db.exec(`CREATE SCHEMA IF NOT EXISTS "${store.db.schema}"`);
        const legacy = await store.db.prepare(`SELECT to_regclass('"User"') AS users, to_regclass('"Message"') AS messages`).get();
        if (legacy?.users || legacy?.messages) throw new Error('检测到旧 Prisma 数据库；请先完成 PostgreSQL 业务数据迁移，禁止自动初始化新版表');
        await runMigrations(store.db, migrationsFor(store));
      });
      return store;
    } catch (error) { await store.close(); throw error; }
  }

  transaction<T>(fn: () => T | Promise<T>): Promise<T> { return this.db.transaction(fn); }
  sessionTransaction<T>(fn: () => T | Promise<T>): Promise<T> { return this.db.session(fn); }
  read<T>(fn: () => T | Promise<T>): Promise<T> { return this.db.read(fn); }
  async setting<T>(key: string): Promise<T> {
    const value = await this.db.cachedSetting(key, async () => {
      const row = await this.db.prepare('SELECT value FROM settings WHERE key=$1').get(key);
      if (!row) throw new DomainError('设置不存在');
      return String(row.value);
    });
    return JSON.parse(value) as T;
  }
  async set(key: string, value: unknown): Promise<void> {
    const serialized = JSON.stringify(value);
    await this.db.prepare('INSERT INTO settings VALUES ($1,$2) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, serialized);
    this.db.rememberSetting(key, serialized);
  }
  rules(): Promise<Rules> { return this.setting<Rules>('rules'); }
  async account(userId: string): Promise<Account> {
    const row = await this.db.prepare('SELECT available,locked,earned,spent FROM accounts WHERE "userId"=$1').get(userId);
    if (!row) throw new DomainError('账户不存在', 404);
    return row as Account;
  }
  async user(userId: string): Promise<User> {
    const row = await this.db.prepare('SELECT u.id,u.name,u.founder,l."createdAt" FROM users u LEFT JOIN legacy_users l ON l.id=u.id WHERE u.id=$1').get<{id:string;name:string;founder:number;createdAt:string|null}>(userId);
    if (!row) throw new DomainError('用户不存在', 404);
    return {id:row.id,name:row.name,username:row.name,founder:!!row.founder,...(row.createdAt?{createdAt:row.createdAt}:{})};
  }
  async message(messageId: string, revision?: number): Promise<Message> {
    const row = revision === undefined
      ? await this.db.prepare('SELECT body FROM messages WHERE id=$1').get(messageId)
      : await this.db.prepare('SELECT body FROM revisions WHERE "messageId"=$1 AND revision=$2').get(messageId, revision);
    if (!row) throw new DomainError('消息或版本不存在', 404);
    return JSON.parse(row.body) as Message;
  }
  async latestSequence(): Promise<number> {
    return (await this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM changes').get())!.n;
  }
  async operating(delta: number, allowDebt = false): Promise<void> {
    const value = integer(await this.setting<number>('operating') + delta);
    if (!allowDebt && value < 0) throw new DomainError('运营资金不足');
    await this.set('operating', value);
  }
  async ledger(userId: string, messageId: string, amount: number, lockedDelta: number, reason: string, allowDebt = false): Promise<LedgerEntry> {
    const entries = this.db.ledger;
    const account = await this.account(userId);
    const available = integer(account.available + amount), locked = integer(account.locked + lockedDelta);
    if (locked < 0 || (!allowDebt && available < 0)) throw new DomainError('可用贡献点不足或锁定资金不足');
    const earned = integer(account.earned + Math.max(0, amount + lockedDelta));
    const spent = integer(account.spent + Math.max(0, -amount - lockedDelta));
    await this.db.prepare('UPDATE accounts SET available=$1,locked=$2,earned=$3,spent=$4 WHERE "userId"=$5').run(available, locked, earned, spent, userId);
    const entry: LedgerEntry = { id: id(), userId, messageId, messageRevision: (await this.message(messageId)).revision, amount, lockedDelta, reason, createdAt: now(), ruleVersion: (await this.rules()).version };
    await this.db.prepare('INSERT INTO ledger(id,"userId","messageId",amount,"lockedDelta",reason,"createdAt","ruleVersion","messageRevision") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)').run(entry.id,userId,messageId,amount,lockedDelta,reason,entry.createdAt,entry.ruleVersion,entry.messageRevision);
    entries.push(entry);
    return entry;
  }
  close(): Promise<void> { return this.db.close(); }
}

export class Mutation {
  messages = new Map<string, Message>();
  memberships = new Map<string, Membership>();
  removed = new Set<string>();
  affected = new Set<string>();
  private readonly ledgerStart: number;
  constructor(public store: Store) { this.ledgerStart = store.db.ledger.length; }

  async put(message: Message): Promise<void> {
    this.messages.set(message.id, message);
    this.affected.add(message.id);
    for (const row of await this.store.db.prepare('SELECT "targetId" FROM refs WHERE "sourceId"=$1').all(message.id)) this.affected.add(row.targetId);
    await this.store.db.prepare('INSERT INTO messages VALUES ($1,$2,$3,$4,$5) ON CONFLICT(id) DO UPDATE SET sequence=excluded.sequence,body=excluded.body').run(message.id,message.authorId,message.createdAt,message.sequence,JSON.stringify(message));
    await this.store.db.prepare('INSERT INTO revisions("messageId",revision,body) VALUES ($1,$2,$3) ON CONFLICT("messageId",revision) DO UPDATE SET body=excluded.body').run(message.id,message.revision,JSON.stringify(message));
    await this.store.db.prepare('DELETE FROM refs WHERE "sourceId"=$1').run(message.id);
    for (const part of message.parts) {
      const targets = part.type === 'relation' ? Object.values(part.roles).flat().map(b => b.reference) : part.type === 'display' && part.target ? [part.target] : [];
      for (const target of targets) {
        this.affected.add(target.messageId);
        await this.store.db.prepare('INSERT INTO refs VALUES ($1,$2) ON CONFLICT DO NOTHING').run(message.id,target.messageId);
      }
    }
  }
  async create(authorId: string, parts: Message['parts'], spending: Message['spending'] = {protocol:0,recommendation:0,wager:0}, messageId?: string): Promise<Message> {
    if (messageId && await this.store.db.prepare('SELECT 1 FROM messages WHERE id=$1').get(messageId)) throw new DomainError('消息编号已经存在',409);
    const timestamp = now();
    const message: Message = { id:messageId??id(),revision:1,authorId,createdAt:timestamp,updatedAt:timestamp,regionId:await this.store.setting<string>('region'),ledgerId:'local',programVersion:'2.0.0',ruleVersion:(await this.store.rules()).version,parts,spending,sequence:0 };
    await this.put(message);
    return message;
  }
  async commit(): Promise<Change> {
    const previousSequence = await this.store.latestSequence();
    const row = await this.store.db.prepare('INSERT INTO changes(body) VALUES ($1) RETURNING sequence').get('{}');
    const sequence = row!.sequence;
    // put() already persisted content and reference indexes. Publishing only
    // changes the cursor; update current/revision bodies together in bounded batches.
    const messages = [...this.messages.values()];
    for (let offset = 0; offset < messages.length; offset += 200) {
      const updates = messages.slice(offset, offset + 200).map(message => {
        message.sequence = sequence;
        return { id: message.id, revision: message.revision, body: JSON.stringify(message) };
      });
      await this.store.db.prepare(`WITH input AS (
        SELECT * FROM jsonb_to_recordset($1::jsonb) AS row(id text,revision integer,body text)
      ), current_messages AS (
        UPDATE messages m SET sequence=$2,body=i.body FROM input i WHERE m.id=i.id RETURNING m.id
      ) UPDATE revisions r SET body=i.body FROM input i WHERE r."messageId"=i.id AND r.revision=i.revision`)
        .run(JSON.stringify(updates), sequence);
    }
    const ledger = this.store.db.ledger.slice(this.ledgerStart);
    const change: Change = { sequence,previousSequence,messages:[...this.messages.values()],memberships:[...this.memberships.values()],removedMemberships:[...this.removed],states:await statesFor(this.store,[...this.affected]),ledger,treasury:{operating:await this.store.setting<number>('operating'),issued:await this.store.setting<number>('minted')} };
    await this.store.db.prepare('UPDATE changes SET body=$1 WHERE sequence=$2').run(JSON.stringify(change),sequence);
    return change;
  }
}
