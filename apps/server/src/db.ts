import { commandIdentity } from './command-identities.js';
import { updateUsageRewardMessage, type Account, type Change, type LedgerEntry, type Membership, type Message, type Rules, type User } from '@gonglun/core';
import { statesFor } from './projections.js';
import { Postgres } from './postgres.js';
import { DATABASE_MIGRATIONS } from './database-version.js';
import { initializeDatabase } from './initialize-database.js';
import { upgradeDatabase } from './database-upgrade.js';
import { recordNotifications } from './notifications.js';
import { indexModerationDependencies, affectModerationDependents } from './moderation-visibility.js';

class DatabaseUpgradeRequired extends Error {}

export const id = commandIdentity;
export const now = () => new Date().toISOString();
export class DomainError extends Error { constructor(message: string, public status = 400, public code?: string) { super(message); } }
export function integer(value: number, label = '金额'): number {
  if (!Number.isSafeInteger(value)) throw new DomainError(`${label}超出安全整数范围`);
  return value;
}

export class Store {
  private ledgerOperationsReady = false;
  private constructor(readonly db: Postgres) {}

  /** Inspect an existing database in one enforced read-only snapshot, without startup upgrades. */
  static async inspect<T>(databaseUrl: string, options: { schema?: string }, read: (store: Store) => T | Promise<T>): Promise<T> {
    const store = new Store(new Postgres(databaseUrl, options.schema));
    try { return await store.read(() => read(store)); }
    finally { await store.close(); }
  }

  static async open(databaseUrl: string, options: { schema?: string; autoMigrate?:boolean } = {}): Promise<Store> {
    const store = new Store(new Postgres(databaseUrl, options.schema));
    try {
      await store.transaction(async () => {
        await store.db.exec(`CREATE SCHEMA IF NOT EXISTS "${store.db.schema}"`);
        const schema = await store.db.prepare("SELECT to_regclass('schema_migrations') AS migrations,to_regclass('messages') AS messages").get();
        if (!schema?.migrations && !schema?.messages) {
          const existing = await store.db.prepare('SELECT COUNT(*)::integer AS n FROM information_schema.tables WHERE table_schema=current_schema()').get();
          if (existing?.n) throw new DatabaseUpgradeRequired('数据库需要迁移，请先执行独立迁移程序');
          await initializeDatabase(store);
          await store.db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)');
          for (const [index,name] of DATABASE_MIGRATIONS.entries())
            await store.db.prepare('INSERT INTO schema_migrations(version,name) VALUES($1,$2)').run(index+1,name);
        } else {
          if (!schema?.migrations) throw new DatabaseUpgradeRequired('数据库需要迁移，请先执行 npm run db:migrate');
          const applied = await store.db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all<{version:number;name:string}>();
          if (applied.some((row,index) => row.version !== index+1 || DATABASE_MIGRATIONS[index] !== row.name))
            throw new Error('数据库版本与当前程序不兼容');
          if (applied.length !== DATABASE_MIGRATIONS.length) throw new DatabaseUpgradeRequired('数据库需要迁移，请先执行 npm run db:migrate');
        }
      });
      return store;
    } catch (error) {
      await store.close();
      if(error instanceof DatabaseUpgradeRequired&&options.autoMigrate!==false){
        const schema=await upgradeDatabase(databaseUrl,options.schema);
        return Store.open(databaseUrl,{schema,autoMigrate:false});
      }
      throw error;
    }
  }

  /** Dedicated maintenance entry point. The caller owns the transaction and all upgrade logic. */
  static maintenance(databaseUrl: string, options: {schema?:string} = {}): Store {
    return new Store(new Postgres(databaseUrl,options.schema));
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
    const row = await this.db.prepare('SELECT id,name,founder,"createdAt" FROM users WHERE id=$1').get<{id:string;name:string;founder:number;createdAt:string|null}>(userId);
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
  async ledger(userId: string, messageId: string, amount: number, lockedDelta: number, reason: string, allowDebt = false, options?: {aggregateId:string;createdAt:string;total:number}): Promise<LedgerEntry> {
    const entries = this.db.ledger;
    const aggregate = options ? await this.db.prepare('SELECT * FROM ledger WHERE id=$1').get(options.aggregateId) : undefined;
    if (options && (amount !== 1 || lockedDelta !== 0 || aggregate && (aggregate.userId !== userId || aggregate.messageId !== messageId || !['使用奖励汇总','使用贡献汇总'].includes(String(aggregate.reason)) || aggregate.lockedDelta !== 0))) throw new DomainError('使用贡献累计记录不一致');
    if (options && Number(aggregate?.amount ?? 0) + 1 !== options.total) throw new DomainError('使用贡献累计金额不一致');
    const account = await this.account(userId);
    const available = integer(account.available + amount), locked = integer(account.locked + lockedDelta);
    if (locked < 0 || (!allowDebt && available < 0)) throw new DomainError('可用贡献点不足或锁定资金不足');
    const earned = integer(account.earned + Math.max(0, amount + lockedDelta));
    const spent = integer(account.spent + Math.max(0, -amount - lockedDelta));
    await this.db.prepare('UPDATE accounts SET available=$1,locked=$2,earned=$3,spent=$4 WHERE "userId"=$5').run(available, locked, earned, spent, userId);
    const entry: LedgerEntry = { id: options && !aggregate ? options.aggregateId : id(), userId, messageId, messageRevision: (await this.message(messageId)).revision, amount, lockedDelta, reason, createdAt: options?.createdAt ?? now(), ruleVersion: (await this.rules()).version };
    if (aggregate) {
      await this.db.prepare('UPDATE ledger SET amount=$2,"createdAt"=$3,"balanceAfter"=$4,position=DEFAULT,reason=\'使用贡献汇总\' WHERE id=$1')
        .run(aggregate.id, integer(Number(aggregate.amount) + amount), entry.createdAt, available);
    } else {
      await this.db.prepare('INSERT INTO ledger(id,"userId","messageId",amount,"lockedDelta",reason,"createdAt","ruleVersion","messageRevision","balanceAfter") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)')
        .run(entry.id,userId,messageId,amount,lockedDelta,options ? '使用贡献汇总' : reason,entry.createdAt,entry.ruleVersion,entry.messageRevision,available);
      // Earlier migrations can still write ledger rows before grouping is installed.
      if (!this.ledgerOperationsReady) this.ledgerOperationsReady = !!(await this.db.prepare("SELECT to_regclass('ledger_operations') AS table_name").get())?.table_name;
      if (this.ledgerOperationsReady) await this.db.prepare('INSERT INTO ledger_operations("entryId","operationId") VALUES ($1,$2)')
        .run(entry.id, this.db.ledgerOperationId);
    }
    entries.push(entry);
    return entry;
  }
  close(): Promise<void> { return this.db.close(); }
}

export class Mutation {
  pointsReset?: Change['pointsReset'];
  createdAccountIds?: string[];
  usageRewardTotals?: Change['usageRewardTotals'];
  messages = new Map<string, Message>();
  memberships = new Map<string, Membership>();
  removed = new Set<string>();
  affected = new Set<string>();
  private readonly ledgerStart: number;
  constructor(public store: Store, public publication?: {authorId:string;joinContribution:{wager:number;recommendation:number}}) { this.ledgerStart = store.db.ledger.length; }

  async put(message: Message): Promise<void> {
    await indexModerationDependencies(this.store,message);
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
    for (const update of this.usageRewardTotals ?? []) {
      const message = updateUsageRewardMessage(await this.store.message(update.messageId), update.total, sequence, update.updatedAt);
      await this.store.db.prepare('UPDATE messages SET sequence=$2,body=$3 WHERE id=$1').run(message.id, sequence, JSON.stringify(message));
      await this.store.db.prepare('UPDATE revisions SET body=$3 WHERE "messageId"=$1 AND revision=$2').run(message.id, message.revision, JSON.stringify(message));
    }
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
    await affectModerationDependents(this.store,this.affected);
    const change: Change = { sequence,previousSequence,messages:[...this.messages.values()],memberships:[...this.memberships.values()],removedMemberships:[...this.removed],states:await statesFor(this.store,[...this.affected]),ledger,treasury:{operating:await this.store.setting<number>('operating'),issued:await this.store.setting<number>('minted')} };
    if (this.pointsReset) change.pointsReset = this.pointsReset;
    if (this.createdAccountIds) change.createdAccountIds = this.createdAccountIds;
    if (this.usageRewardTotals) change.usageRewardTotals = this.usageRewardTotals;
    await this.store.db.prepare('UPDATE changes SET body=$1 WHERE sequence=$2').run(JSON.stringify(change),sequence);
    await recordNotifications(this.store, change);
    return change;
  }
}
