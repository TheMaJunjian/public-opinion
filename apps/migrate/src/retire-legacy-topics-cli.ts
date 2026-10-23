import { writeFile } from 'node:fs/promises';
import { Store } from '../../server/src/db.js';
import { Postgres } from '../../server/src/postgres.js';
import { planTopicRetirement, retireLegacyTopics } from './retire-legacy-topics.js';

const args = process.argv.slice(2);
if (args.some((arg, index) => arg.startsWith('--') && !['--apply', '--expect-region', '--report'].includes(arg)
  || ['--expect-region', '--report'].includes(arg) && (!args[index + 1] || args[index + 1].startsWith('--'))))
  throw new Error('Usage: db:topic-retirement [--apply --expect-region REGION] [--report PATH]');
const value = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('请配置 DATABASE_URL');
const db = new Postgres(databaseUrl, process.env.DATABASE_SCHEMA);
let preflight;
try {
  preflight = await db.read(async () => {
    const identity = await db.prepare('SELECT current_database() AS database,current_schema() AS schema').get<{database:string;schema:string}>();
    if (!identity) throw new Error('数据库身份读取失败');
    const region = JSON.parse(String((await db.prepare("SELECT value FROM settings WHERE key='region'").get())?.value));
    const plan = await planTopicRetirement({ db });
    return { ...identity, region, ...plan };
  });
} finally { await db.close(); }
if (args.includes('--apply') && value('--expect-region') !== preflight.region)
  throw new Error('执行前必须提供预检报告的 --expect-region，确认正在升级同一数据源');
let applied = false;
if (args.includes('--apply')) {
  const store = Store.maintenance(databaseUrl, { schema: process.env.DATABASE_SCHEMA });
  try {
    await store.transaction(async () => {
      if (await store.setting<string>('region') !== preflight.region) throw new Error('数据源已变化');
      await retireLegacyTopics(store);
      const versions=await store.db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
      if(versions.length===2)await store.db.prepare('INSERT INTO schema_migrations(version,name) VALUES(3,$1)').run('retire-converted-topic-containers');
    });
    applied = true;
  } finally { await store.close(); }
}
const report = { ...preflight, applied };
if (value('--report')) await writeFile(value('--report')!, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ database: preflight.database, schema: preflight.schema, region: preflight.region, applied,
  topics: preflight.topicIds.length, directMemberships: preflight.releasedMemberships.length,
  retiredJoins: preflight.retiredJoinIds.length, deletedMessages: 0 }, null, 2));
