import { openMigratingStore } from './migrations.js';
import {migrationPlan} from './preflight.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('请配置 DATABASE_URL 连接需要迁移的 PostgreSQL');
if(process.argv.slice(2).some(arg=>arg!=='--plan'))throw new Error('用法：db:migrate [--plan]');
const plan=await migrationPlan(databaseUrl,process.env.DATABASE_SCHEMA);
console.log('迁移预检',JSON.stringify(plan));
if(!process.argv.includes('--plan')){
  const store = await openMigratingStore(databaseUrl, { schema: process.env.DATABASE_SCHEMA });
  try {
    const rows = await store.db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all();
    console.log('数据库迁移完成', rows);
  } finally { await store.close(); }
}
