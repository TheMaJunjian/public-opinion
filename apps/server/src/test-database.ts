import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createApp } from './app.js';
import { Store } from './db.js';

// Never fall back to the deployment DATABASE_URL: integration tests get their
// own namespace on an explicitly configured test server or the local dev server.
export const testDatabaseUrl = () => process.env.TEST_DATABASE_URL ?? 'postgresql://gonglun:gonglun_dev@127.0.0.1:54329/gonglun';
const schemas = new Set<string>();
const resources: Array<{ close(): Promise<void> }> = [];

export function newTestSchema(): string {
  const schema = `gonglun_test_${randomUUID().replaceAll('-', '')}`;
  schemas.add(schema);
  return schema;
}

export async function createTestApp(options: { settlementTickMs?: number; databaseSchema?: string } = {}) {
  const databaseSchema = options.databaseSchema ?? newTestSchema();
  if (!schemas.has(databaseSchema)) throw new Error('测试只能访问本轮创建的 schema');
  const app = await createApp({ settlementTickMs: 60_000, ...options, databaseSchema, databaseUrl: testDatabaseUrl() });
  resources.push(app);
  return app;
}

export async function createTestStore(schema = newTestSchema()) {
  if (!schemas.has(schema)) throw new Error('测试只能访问本轮创建的 schema');
  const store = await Store.open(testDatabaseUrl(), { schema });
  resources.push(store);
  return store;
}

export async function cleanupTestDatabases(): Promise<void> {
  for (const resource of resources.splice(0)) await resource.close();
  if (!schemas.size) return;
  const pool = new Pool({ connectionString: testDatabaseUrl() });
  try {
    for (const schema of schemas) {
      if (!/^gonglun_test_[a-f0-9]{32}$/.test(schema)) throw new Error('拒绝删除非测试 schema');
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      schemas.delete(schema);
    }
  } finally { await pool.end(); }
}
