// Explicit, isolated integration check. Never uses the repository's .env or live databases.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { synchronize, runCommand } from './sync-vps-db.mjs';
import { verifyExistingDatabase } from './image-database.mjs';
import { DATABASE_MIGRATIONS } from '../apps/server/src/database-version.ts';

const repository = fileURLToPath(new URL('../', import.meta.url));

const context = runCommand('docker', ['context', 'show'], { capture: true }).trim();
const endpoint = JSON.parse(runCommand('docker', ['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}'], { capture: true }));
assert.match(endpoint, /^(npipe|unix):\/\//, 'This check requires a local Docker context.');
const root = mkdtempSync(join(tmpdir(), 'gonglun-vps-sync-real-'));
const deployment = join(root, 'deploy'), backup = join(deployment, 'backups/synthetic');
mkdirSync(backup, { recursive: true });
const project = `gonglun-vps-sync-real-${randomUUID().slice(0, 8)}`;
const composeFile = join(deployment, 'docker-compose.dev.yml');
writeFileSync(composeFile, `name: ${project}
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: gonglun
      POSTGRES_PASSWORD: gonglun_dev
      POSTGRES_DB: postgres
    tmpfs:
      - /var/lib/postgresql/data
    ports:
      - "127.0.0.1::5432"
    healthcheck:
      test: [CMD-SHELL, "pg_isready -U gonglun -d postgres"]
      interval: 1s
      timeout: 3s
      retries: 30
`);
const original = '# isolated configuration\nDATABASE_URL=postgresql://gonglun:gonglun_dev@127.0.0.1:54329/original\nPORT=3000\n';
writeFileSync(join(root, '.env'), original);
const dc = ['--context', context, 'compose', '--project-name', project, '-f', composeFile];
const docker = (args, capture = false) => runCommand('docker', [...dc, ...args], { cwd: root, capture });
const sql = (database, command) => docker(['exec', '-T', 'postgres', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'gonglun', '-d', database, '-c', command], true).trim();
try {
  docker(['up', '-d', '--wait', 'postgres']);
  const port = docker(['port', 'postgres', '5432'], true).trim().split(':').at(-1);
  assert.match(port, /^\d+$/);
  sql('postgres', 'CREATE DATABASE source_snapshot');
  runCommand(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import {Store,Mutation} from './apps/server/src/db.ts';
    const store=await Store.open(process.env.DATABASE_URL,{schema:'business'});
    try{await store.transaction(async()=>{
      await store.db.prepare('INSERT INTO users(id,name,password,founder) VALUES($1,$2,$3,$4)').run('one','one','synthetic-hash',1);
      await store.db.prepare('INSERT INTO users(id,name,password,founder) VALUES($1,$2,$3,$4)').run('two','two','synthetic-hash',0);
      const tx=new Mutation(store);
      await tx.create('one',[{id:'body',type:'text',text:'first'}]);
      await tx.create('two',[{id:'body',type:'text',text:'second'}]);
      await tx.commit();
      await store.db.exec('DELETE FROM schema_migrations WHERE version>=8');
    });}finally{await store.close();}
  `], { cwd: repository, env: { ...process.env, DATABASE_URL: `postgresql://gonglun:gonglun_dev@127.0.0.1:${port}/source_snapshot` } });
  sql('source_snapshot', `CREATE TABLE business.items(id serial PRIMARY KEY, body text NOT NULL);
    INSERT INTO business.items(body) VALUES ('first'), ('second');`);
  docker(['exec', '-T', 'postgres', 'pg_dump', '-U', 'gonglun', '-d', 'source_snapshot', '-Fc', '-f', '/tmp/source.dump']);
  docker(['cp', 'postgres:/tmp/source.dump', join(backup, 'database.dump')]);
  const metadata = 'database=source_snapshot\nschema=business\ncreated_at_utc=2026-10-21T00:00:00Z\n';
  writeFileSync(join(backup, 'metadata.txt'), metadata);
  const hash = value => createHash('sha256').update(value).digest('hex');
  writeFileSync(join(backup, 'SHA256SUMS'), `${hash(readFileSync(join(backup, 'database.dump')))}  database.dump\n${hash(metadata)}  metadata.txt\n`);
  const answers = ['2', '', '1', '', 'restored_snapshot', 'y'];
  const result = await synchronize({
    repoRoot: root,
    ask: async (_, fallback) => { assert.ok(answers.length); return answers.shift() || fallback; },
    run: (command, args, options) => {
      if (command === process.execPath) {
        const url = new URL(options.env.DATABASE_URL);
        url.port = port;
        return runCommand(command, args, { ...options, env: { ...options.env, DATABASE_URL: url.toString() } });
      }
      assert.equal(command, 'docker', 'This local smoke check must not contact SSH/SCP.');
      const actual = [...args];
      const index = actual.indexOf('--project-name');
      if (index >= 0) actual[index + 1] = project;
      return runCommand(command, actual, options);
    },
    verifyDatabase: (configuration, ...options) => {
      const url = new URL(configuration.url);
      url.port = port;
      return verifyExistingDatabase({ ...configuration, url: url.toString() }, ...options);
    },
  });
  assert.equal(result.switched, true);
  assert.equal(sql('restored_snapshot', 'SELECT id,body FROM business.items ORDER BY id'), '1|first\n2|second');
  assert.equal(sql('restored_snapshot', "INSERT INTO business.items(body) VALUES ('third') RETURNING id"), '3');
  assert.equal(sql('source_snapshot', 'SELECT count(*) FROM business.items'), '2');
  assert.equal(sql('source_snapshot', 'SELECT max(version) FROM business.schema_migrations'), '7');
  assert.equal(sql('restored_snapshot', 'SELECT max(version) FROM business.schema_migrations'), String(DATABASE_MIGRATIONS.length));
  assert.equal(readFileSync(result.previous, 'utf8'), original);
  assert.match(readFileSync(join(root, '.env'), 'utf8'), /\/restored_snapshot\nPORT=3000\nDATABASE_SCHEMA=business/);
  console.log('PASS: real PostgreSQL 16 archive/checksum/restore/independent upgrade/replay validation/env switch; schema, rows and sequence preserved; source remains at version 7.');
} finally {
  assert.ok(project.startsWith('gonglun-vps-sync-real-'));
  docker(['down', '--remove-orphans']);
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(basename(root).startsWith('gonglun-vps-sync-real-'));
  rmSync(root, { recursive: true, force: true });
}
