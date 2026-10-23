import { Client } from 'pg';
import {readFileSync} from 'node:fs';

export function databaseConfiguration(env) {
  const rehearsal = env.GONGLUN_REHEARSAL === '1';
  const connection = rehearsal ? env.MIGRATION_TARGET_DATABASE_URL : env.DATABASE_URL;
  if (!connection) throw new Error('缺少已迁移数据库的连接配置');
  const url = new URL(connection);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('数据库连接协议无效');
  if (rehearsal) {
    if (!['localhost', '127.0.0.1', 'postgres'].includes(url.hostname)) throw new Error('演练目标必须是本机 PostgreSQL');
    url.hostname = 'postgres'; url.port = '5432';
  }
  const schema = (rehearsal ? env.MIGRATION_TARGET_SCHEMA : env.DATABASE_SCHEMA) || 'public';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('数据库 schema 名称无效');
  if (!url.pathname.slice(1)) throw new Error('必须明确指定数据库名');
  return { url: url.toString(), schema, rehearsal, database: decodeURIComponent(url.pathname.slice(1)) };
}

/** Read-only preflight. Never creates schemas/tables or initializes an empty DB. */
export async function verifyExistingDatabase(configuration, ClientType = Client, versions=JSON.parse(readFileSync(new URL('../apps/server/dist/database-version.json',import.meta.url),'utf8')),options={}) {
  const client = new ClientType({ connectionString: configuration.url, connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const versionTable=options.allowPending?await client.query('SELECT to_regclass($1) AS name',[`${configuration.schema}.schema_migrations`]):null;
    const applied=versionTable&&!versionTable.rows[0]?.name?{rows:[]}:await client.query(`SELECT version,name FROM "${configuration.schema}".schema_migrations ORDER BY version`);
    if((!options.allowPending&&applied.rows.length!==versions.length)||applied.rows.some((row,index)=>row.version!==index+1||row.name!==versions[index]))
      throw new Error('数据库需要先使用独立迁移程序升级');
    const migration = await client.query(`SELECT value FROM "${configuration.schema}".settings WHERE key='access-mode'`);
    const users = await client.query(`SELECT COUNT(*)::integer AS count FROM "${configuration.schema}".users`);
    if (users.rows[0].count < 1) throw new Error('目标库没有已有用户，拒绝启动空站点');
    let mode = migration.rows[0] ? JSON.parse(migration.rows[0].value) : undefined;
    if(!mode&&options.allowPending){
      const previous=await client.query(`SELECT value FROM "${configuration.schema}".settings WHERE key='migration'`);
      if(previous.rows[0]&&JSON.parse(previous.rows[0].value).mode==='read-only-rehearsal')mode='read-only';
    }
    if (configuration.rehearsal && mode !== 'read-only') throw new Error('目标不是已迁移的只读演练库');
    if (!configuration.rehearsal && mode === 'read-only') throw new Error('只读演练库须使用 --rehearsal，不能作为正式站点启动');
    await client.query('COMMIT');
    return { database: configuration.database, schema: configuration.schema, users: users.rows[0].count, mode: mode || 'production' };
  } finally { await client.end(); }
}
