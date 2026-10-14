import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_RULES, type Account, type Change, type LedgerEntry, type Membership, type Message, type Rules, type User } from '@gonglun/core';
import { initializeProjections, statesFor } from './projections.js';
import { initializePersonal } from './personal-actions.js';

export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export class DomainError extends Error { constructor(message: string, public status = 400) { super(message); } }
export function integer(value: number, label = '金额'): number {
  if (!Number.isSafeInteger(value)) throw new DomainError(`${label}超出安全整数范围`);
  return value;
}
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS rule_versions(version INTEGER PRIMARY KEY,body TEXT NOT NULL,authorizationId TEXT,createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT UNIQUE NOT NULL,password TEXT NOT NULL,founder INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts(userId TEXT PRIMARY KEY,available INTEGER NOT NULL,locked INTEGER NOT NULL,earned INTEGER NOT NULL,spent INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,userId TEXT NOT NULL,csrf TEXT NOT NULL,expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,authorId TEXT NOT NULL,createdAt TEXT NOT NULL,sequence INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS message_sequence ON messages(sequence,id);
      CREATE INDEX IF NOT EXISTS message_author ON messages(authorId,sequence);
      CREATE TABLE IF NOT EXISTS revisions(messageId TEXT NOT NULL,revision INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(messageId,revision));
      CREATE TABLE IF NOT EXISTS memberships(memberId TEXT PRIMARY KEY,parentId TEXT NOT NULL,sourceId TEXT NOT NULL,sourcePartId TEXT,bindingId TEXT,sourceRevision INTEGER);
      CREATE INDEX IF NOT EXISTS members_parent ON memberships(parentId,memberId);
      CREATE TABLE IF NOT EXISTS refs(sourceId TEXT NOT NULL,targetId TEXT NOT NULL,PRIMARY KEY(sourceId,targetId));
      CREATE INDEX IF NOT EXISTS refs_target ON refs(targetId,sourceId);
      CREATE TABLE IF NOT EXISTS rounds(id TEXT PRIMARY KEY,targetKey TEXT NOT NULL,body TEXT NOT NULL,createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS round_target ON rounds(targetKey,createdAt);
      CREATE TABLE IF NOT EXISTS bets(id TEXT PRIMARY KEY,roundId TEXT NOT NULL,targetKey TEXT NOT NULL,userId TEXT NOT NULL,messageId TEXT NOT NULL,side TEXT NOT NULL,amount INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS bets_target ON bets(targetKey);
      CREATE TABLE IF NOT EXISTS execution_stances(sourceId TEXT NOT NULL,revision INTEGER NOT NULL,partId TEXT NOT NULL,target TEXT NOT NULL,side TEXT NOT NULL,PRIMARY KEY(sourceId,revision,partId));
      CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY,userId TEXT NOT NULL,messageId TEXT NOT NULL,amount INTEGER NOT NULL,lockedDelta INTEGER NOT NULL,reason TEXT NOT NULL,createdAt TEXT NOT NULL,ruleVersion INTEGER NOT NULL,messageRevision INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS ledger_user ON ledger(userId,createdAt,id);
      CREATE TABLE IF NOT EXISTS changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests(userId TEXT NOT NULL,requestId TEXT NOT NULL,input TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(userId,requestId));
      CREATE TABLE IF NOT EXISTS effects(key TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS escrows(messageId TEXT PRIMARY KEY,ownerId TEXT NOT NULL,amount INTEGER NOT NULL,recipientId TEXT,fulfillmentId TEXT);
    `);
    if(!this.db.prepare('PRAGMA table_info(ledger)').all().some(column=>column.name==='messageRevision'))this.db.exec('ALTER TABLE ledger ADD COLUMN messageRevision INTEGER NOT NULL DEFAULT 1');
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('rules', JSON.stringify(DEFAULT_RULES));
    this.db.prepare('INSERT OR IGNORE INTO rule_versions VALUES (?,?,NULL,?)').run(DEFAULT_RULES.version,JSON.stringify(DEFAULT_RULES),now());
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('operating', '0');
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('region', JSON.stringify(id()));
    this.db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('minted', '0');
    initializeProjections(this);
    initializePersonal(this);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  setting<T>(key: string): T { const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as {value:string}|undefined; if (!row) throw new DomainError('设置不存在'); return JSON.parse(row.value) as T; }
  set(key: string, value: unknown) { this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  rules(): Rules { return this.setting<Rules>('rules'); }
  account(userId: string): Account {
    const row = this.db.prepare('SELECT available,locked,earned,spent FROM accounts WHERE userId=?').get(userId);
    if (!row) throw new DomainError('账户不存在', 404); return row as unknown as Account;
  }
  user(userId: string): User {
    const row = this.db.prepare('SELECT id,name,founder FROM users WHERE id=?').get(userId) as {id:string;name:string;founder:number}|undefined;
    if (!row) throw new DomainError('用户不存在', 404); return {...row, founder: !!row.founder};
  }
  message(messageId: string, revision?: number): Message {
    const row = revision === undefined
      ? this.db.prepare('SELECT body FROM messages WHERE id=?').get(messageId)
      : this.db.prepare('SELECT body FROM revisions WHERE messageId=? AND revision=?').get(messageId, revision);
    if (!row) throw new DomainError('消息或版本不存在', 404);
    return JSON.parse(row.body as string) as Message;
  }
  latestSequence(): number { return Number(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS n FROM changes').get()!.n); }
  operating(delta: number, allowDebt = false) {
    const value = integer(this.setting<number>('operating') + delta);
    if (!allowDebt && value < 0) throw new DomainError('运营资金不足'); this.set('operating',value);
  }
  ledger(userId: string, messageId: string, amount: number, lockedDelta: number, reason: string, allowDebt = false): LedgerEntry {
    const account = this.account(userId);
    const available = integer(account.available + amount), locked = integer(account.locked + lockedDelta);
    if (locked < 0 || (!allowDebt && available < 0)) throw new DomainError('可用贡献点不足或锁定资金不足');
    const earned = integer(account.earned + Math.max(0, amount + lockedDelta));
    const spent = integer(account.spent + Math.max(0, -amount - lockedDelta));
    this.db.prepare('UPDATE accounts SET available=?,locked=?,earned=?,spent=? WHERE userId=?').run(available,locked,earned,spent,userId);
    const entry: LedgerEntry = {id:id(),userId,messageId,messageRevision:this.message(messageId).revision,amount,lockedDelta,reason,createdAt:now(),ruleVersion:this.rules().version};
    this.db.prepare('INSERT INTO ledger VALUES (?,?,?,?,?,?,?,?,?)').run(entry.id,userId,messageId,amount,lockedDelta,reason,entry.createdAt,entry.ruleVersion,entry.messageRevision);
    return entry;
  }
  close() { this.db.close(); }
}

export class Mutation {
  messages = new Map<string,Message>();
  memberships = new Map<string,Membership>();
  removed = new Set<string>();
  affected = new Set<string>();
  private ledgerStart:number;
  constructor(public store: Store) {this.ledgerStart=Number(store.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM ledger').get()!.n);}
  put(message: Message) {
    this.messages.set(message.id,message);
    this.affected.add(message.id);
    for(const row of this.store.db.prepare('SELECT targetId FROM refs WHERE sourceId=?').all(message.id))this.affected.add(String(row.targetId));
    this.store.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sequence=excluded.sequence,body=excluded.body').run(message.id,message.authorId,message.createdAt,message.sequence,JSON.stringify(message));
    this.store.db.prepare('INSERT OR REPLACE INTO revisions VALUES (?,?,?)').run(message.id,message.revision,JSON.stringify(message));
    this.store.db.prepare('DELETE FROM refs WHERE sourceId=?').run(message.id);
    for(const part of message.parts) {
      const targets=part.type==='relation'?Object.values(part.roles).flat().map(b=>b.reference):part.type==='display'&&part.target?[part.target]:[];
      for(const target of targets){this.affected.add(target.messageId);this.store.db.prepare('INSERT OR IGNORE INTO refs VALUES (?,?)').run(message.id,target.messageId);}
    }
  }
  create(authorId: string, parts: Message['parts'], spending: Message['spending'] = {protocol:0,recommendation:0,wager:0}): Message {
    const timestamp=now(); const message: Message={id:id(),revision:1,authorId,createdAt:timestamp,updatedAt:timestamp,regionId:this.store.setting<string>('region'),ledgerId:'local',programVersion:'2.0.0',ruleVersion:this.store.rules().version,parts,spending,sequence:0};
    this.put(message); return message;
  }
  commit(): Change {
    const row=this.store.db.prepare('INSERT INTO changes(body) VALUES (?)').run('{}');
    const sequence=Number(row.lastInsertRowid);
    for(const message of this.messages.values()) { message.sequence=sequence; this.put(message); }
    const ledger=this.store.db.prepare('SELECT * FROM ledger WHERE rowid>? ORDER BY rowid').all(this.ledgerStart) as unknown as LedgerEntry[];
    const change:Change={sequence,messages:[...this.messages.values()],memberships:[...this.memberships.values()],removedMemberships:[...this.removed],states:statesFor(this.store,[...this.affected]),ledger,treasury:{operating:this.store.setting<number>('operating'),issued:this.store.setting<number>('minted')}};
    this.store.db.prepare('UPDATE changes SET body=? WHERE sequence=?').run(JSON.stringify(change),sequence);
    return change;
  }
}
