import { Store } from './db.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('请配置 DATABASE_URL 连接需要迁移的 PostgreSQL');
const store = await Store.open(databaseUrl, { schema: process.env.DATABASE_SCHEMA });
try {
  const rows = await store.db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all();
  console.log('数据库迁移完成', rows);
} finally { await store.close(); }
