import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Store } from '../../server/src/db.js';
import { archivedTableFingerprint, type ArchiveManifest } from './points-archive-integrity.js';

const [output, archiveId] = process.argv.slice(2);
if (!process.env.DATABASE_URL || !output || process.argv.length > 5) throw new Error('用法：npm run db:points-archive -- 输出.json [归档编号]；使用 --list 查看归档');
await Store.inspect(process.env.DATABASE_URL, { schema: process.env.DATABASE_SCHEMA }, async store => {
  if (output === '--list') {
    console.log(JSON.stringify(await store.db.prepare('SELECT * FROM points_archives ORDER BY "createdAt",id').all(), null, 2));
    return;
  }
  const archive = archiveId
    ? await store.db.prepare('SELECT * FROM points_archives WHERE id=$1').get(archiveId)
    : await store.db.prepare('SELECT * FROM points_archives ORDER BY "createdAt" DESC,id DESC LIMIT 1').get();
  if (!archive) throw new Error('没有可导出的旧贡献点归档');
  const rows = await store.db.prepare('SELECT "tableName",body FROM points_archive_rows WHERE "archiveId"=$1 ORDER BY position').all(archive.id);
  const tables: Record<string,unknown[]> = {};
  for (const row of rows) (tables[String(row.tableName)] ??= []).push(row.body);
  for (const [table, expected] of Object.entries(archive.manifest as ArchiveManifest)) {
    tables[table] ??= [];
    const actual = await archivedTableFingerprint(store, String(archive.id), table);
    if (actual.count !== expected.count || actual.sha256 !== expected.sha256) throw new Error(`归档记录数量或摘要不一致：${table}`);
  }
  const payload = { format: 'gonglun-points-archive-1', archive, tables };
  const sha256 = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  await writeFile(output, JSON.stringify({ ...payload, sha256 }, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, archiveId: archive.id, sha256 }));
});
