import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';
import type { LedgerEntry } from '@gonglun/core';

type Row = QueryResultRow;
type Transaction = { client: PoolClient; ledger: LedgerEntry[]; savepoint: number; pending: Promise<void>; readOnly?: boolean };

function safeInteger(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError('数据库整数超出安全范围');
  return number;
}

/** Native PostgreSQL queries. A transaction always uses one checked-out connection. */
export class Postgres {
  private readonly pool: Pool;
  private readonly context = new AsyncLocalStorage<Transaction>();
  private closing?: Promise<void>;
  readonly schema: string;

  constructor(databaseUrl: string, schema = 'public') {
    if (!databaseUrl) throw new Error('请设置 DATABASE_URL，连接 PostgreSQL 数据库');
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('数据库 schema 名称无效');
    this.schema = schema;
    this.pool = new Pool({
      connectionString: databaseUrl,
      max: 10,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      options: `-c search_path=${schema}`,
      types: { getTypeParser: (oid, format) => oid === 20 ? safeInteger : types.getTypeParser(oid, format) },
    });
    this.pool.on('error', error => console.error('PostgreSQL 空闲连接出错', error));
  }

  private async query<R extends Row = Row>(sql: string, values: unknown[] = []) {
    const transaction = this.context.getStore();
    if (!transaction) return this.pool.query<R>(sql, values);
    // Projections may request several reads together, but one PostgreSQL client
    // executes one query at a time. Drain this queue before commit or rollback.
    const result = transaction.pending.then(() => transaction.client.query<R>(sql, values));
    transaction.pending = result.then(() => {}, () => {});
    return result;
  }

  prepare(sql: string) {
    return {
      get: async <R extends Row = Row>(...values: unknown[]): Promise<R | undefined> => (await this.query<R>(sql, values)).rows[0],
      all: async <R extends Row = Row>(...values: unknown[]): Promise<R[]> => (await this.query<R>(sql, values)).rows,
      run: async (...values: unknown[]) => {
        const result = await this.query(sql, values);
        return { rowCount: result.rowCount ?? 0, rows: result.rows };
      },
    };
  }

  async exec(sql: string): Promise<void> { await this.query(sql); }

  get ledger(): LedgerEntry[] {
    const transaction = this.context.getStore();
    if (!transaction || transaction.readOnly) throw new Error('消息和账本修改必须在写事务中执行');
    return transaction.ledger;
  }

  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    const parent = this.context.getStore();
    if (parent) {
      if (parent.readOnly) throw new Error('不能在只读事务中修改消息');
      const savepoint = `nested_${++parent.savepoint}`;
      const ledgerStart = parent.ledger.length;
      await this.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = await fn();
        await this.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        await this.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await this.exec(`RELEASE SAVEPOINT ${savepoint}`);
        parent.ledger.length = ledgerStart;
        throw error;
      }
    }
    const client = await this.pool.connect();
    const transaction: Transaction = { client, ledger: [], savepoint: 0, pending: Promise.resolve() };
    let releaseError: Error | undefined;
    try {
      await client.query('BEGIN');
      // Commands share a treasury and an ordered change stream. Serialize their
      // commits across API processes; readers and other regions remain independent.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('gonglun'), hashtext(current_database() || ':' || $1))", [this.schema]);
      const result = await this.context.run(transaction, fn);
      await transaction.pending;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await transaction.pending;
      try { await client.query('ROLLBACK'); } catch (rollbackError) { releaseError = rollbackError as Error; }
      throw error;
    } finally { client.release(releaseError); }
  }

  async read<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.context.getStore()) return fn();
    const client = await this.pool.connect();
    const transaction: Transaction = { client, ledger: [], savepoint: 0, readOnly: true, pending: Promise.resolve() };
    let releaseError: Error | undefined;
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await this.context.run(transaction, fn);
      await transaction.pending;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await transaction.pending;
      try { await client.query('ROLLBACK'); } catch (rollbackError) { releaseError = rollbackError as Error; }
      throw error;
    } finally { client.release(releaseError); }
  }

  close(): Promise<void> { return this.closing ??= this.pool.end(); }
}
