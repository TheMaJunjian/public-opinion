import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { databaseConfiguration, verifyExistingDatabase } from './image-database.mjs';

const target = { GONGLUN_REHEARSAL: '1', MIGRATION_TARGET_DATABASE_URL: 'postgresql://gonglun:test-password@127.0.0.1:54330/gonglun_v2_rehearsal', MIGRATION_TARGET_SCHEMA: 'public' };
test('rehearsal keeps the exact migrated DB, schema and credentials when using container networking', () => {
  const configuration = databaseConfiguration({ ...target, DATABASE_URL: 'postgresql://ignored:ignored@postgres/gonglun', MIGRATION_TARGET_SCHEMA: 'verified_target' });
  const url = new URL(configuration.url);
  assert.equal(url.hostname, 'postgres'); assert.equal(url.port, '5432');
  assert.equal(url.pathname, '/gonglun_v2_rehearsal'); assert.equal(url.password, 'test-password');
  assert.equal(configuration.schema, 'verified_target');
  for (const env of [{ GONGLUN_REHEARSAL: '1' }, { ...target, MIGRATION_TARGET_SCHEMA: 'public; DROP SCHEMA public' }, { ...target, MIGRATION_TARGET_DATABASE_URL: 'postgresql://user:pass@old-server/legacy' }]) {
    assert.throws(() => databaseConfiguration(env));
  }
});

test('database preflight only reads and rejects empty, legacy and non-read-only rehearsal targets', async () => {
  for (const scenario of ['valid', 'empty', 'legacy', 'native', 'production']) {
    const queries = []; let closed = false;
    class FakeClient {
      async connect() {}
      async query(sql) {
        queries.push(sql);
        if (scenario === 'legacy') throw new Error('relation settings does not exist');
        if(sql.includes('.schema_migrations'))return {rows:[{version:1,name:'current-schema'}]};
        if (sql.includes('.settings')) return { rows: [{ value: JSON.stringify(scenario === 'native' ? 'read-write' : 'read-only') }] };
        return { rows: [{ count: scenario === 'empty' ? 0 : 252 }] };
      }
      async end() { closed = true; }
    }
    const configuration = databaseConfiguration(scenario === 'production' ? { DATABASE_URL: target.MIGRATION_TARGET_DATABASE_URL } : target);
    if (scenario === 'valid') assert.equal((await verifyExistingDatabase(configuration, FakeClient,['current-schema'])).users, 252);
    else await assert.rejects(verifyExistingDatabase(configuration, FakeClient,['current-schema']));
    assert.ok(closed); assert.ok(queries.every(sql => /^(BEGIN .*READ ONLY|SELECT |COMMIT)/.test(sql)));
    assert.ok(!queries.some(sql => /CREATE|INSERT|UPDATE|DELETE|DROP/.test(sql)));
  }
});

test('read-only deployment preflight accepts pending native upgrades while rejecting future versions',async()=>{
  for(const scenario of ['unversioned','previous','rehearsal','future']){
    const queries=[];
    class FakeClient{
      async connect(){}
      async end(){}
      async query(sql){
        queries.push(sql);
        if(sql.includes('to_regclass'))return {rows:[{name:scenario==='unversioned'?null:'schema_migrations'}]};
        if(sql.includes('.schema_migrations'))return {rows:scenario==='future'?[{version:1,name:'old-schema'},{version:2,name:'newer-than-image'}]:[{version:1,name:'old-schema'}]};
        if(sql.includes("key='access-mode'"))return {rows:[]};
        if(sql.includes("key='migration'"))return {rows:scenario==='rehearsal'?[{value:JSON.stringify({mode:'read-only-rehearsal'})}]:[]};
        return {rows:[{count:2}]};
      }
    }
    const configuration=databaseConfiguration(scenario==='rehearsal'?target:{DATABASE_URL:target.MIGRATION_TARGET_DATABASE_URL});
    const run=verifyExistingDatabase(configuration,FakeClient,['old-schema','next-schema'],{allowPending:true});
    if(scenario==='future')await assert.rejects(run,/独立迁移程序/);
    else assert.equal((await run).users,2);
    assert.ok(queries.every(sql=>/^(BEGIN .*READ ONLY|SELECT |COMMIT)/.test(sql)));
  }
});

const bash = process.platform === 'win32' ? resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/bash.exe') : 'bash';
function deploy(t, flags = [], overrides = {}, entry = 'deploy.sh') {
  const directory = mkdtempSync(join(tmpdir(), 'gonglun-deploy-test-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('gonglun-deploy-test-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const deployment = join(directory, 'deploy'), bin = join(directory, 'bin'), log = join(directory, 'docker.log');
  mkdirSync(deployment); mkdirSync(bin);
  copyFileSync(resolve('deploy/deploy.sh'), join(deployment, 'deploy.sh'));
  copyFileSync(resolve('deploy/update.sh'), join(deployment, 'update.sh'));
  writeFileSync(join(deployment, '.env.prod'), 'POSTGRES_PASSWORD=keep-existing-password\nGONGLUN_DATABASE_NAME=existing-final\n');
  writeFileSync(join(directory, '.env.migration'), 'MIGRATION_TARGET_DATABASE_URL=keep-existing-migrated-target\n');
  if (overrides.MOCK_PREVIOUS_DEPLOYMENT === '1') writeFileSync(join(deployment, '.env.image'), 'GONGLUN_IMAGE=gonglun:previous\nGONGLUN_DEPLOY_MODE=production\n');
  writeFileSync(join(bin, 'docker'), `#!/usr/bin/env bash
printf '%s\\t' "$@" >> "$DOCKER_TEST_LOG"; printf '\\n' >> "$DOCKER_TEST_LOG"
case "$1" in
  inspect)
    case "$3" in
      '{{.State.Running}}') echo true ;;
      '{{.Config.Image}}') if [ "$MOCK_WRONG_IMAGE" = 1 ]; then echo gonglun:previous; else printf 'gonglun:sha-%040d\\n' 0; fi ;;
      *) if [ "$4" = "current-$MOCK_UNHEALTHY-container" ]; then echo 'running unhealthy'; elif [ "$4" = current-caddy-container ]; then echo 'running none'; else echo 'running healthy'; fi ;;
    esac ;;
  info) echo x86_64 ;;
  load) touch "$DOCKER_TEST_LOG.loaded" ;;
  image)
    if [ "$3" = --format ]; then printf '%040d\\n' 0
    elif [ "$MOCK_LOCAL_IMAGE" != 1 ] && [ ! -f "$DOCKER_TEST_LOG.loaded" ]; then exit 1; fi ;;
  compose)
    case " $* " in
      *" ps -q postgres "*) [ "$MOCK_NO_DATABASE" = 1 ] || echo original-postgres-container ;;
      *" ps -q api "*) [ "$MOCK_MISSING_API" = 1 ] || echo current-api-container ;;
      *" ps -q caddy "*) echo current-caddy-container ;;
      *" run "*) [ "$MOCK_BAD_TARGET" != 1 ] ;;
      *" exec "*) [ "$MOCK_HEALTH_FAILURE" != 1 ] ;;
    esac ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, 'git'), `#!/usr/bin/env bash
printf 'git\\t' >> "$DOCKER_TEST_LOG"; printf '%s\\t' "$@" >> "$DOCKER_TEST_LOG"; printf '\\n' >> "$DOCKER_TEST_LOG"
case " $* " in
  *" symbolic-ref --quiet --short HEAD "*) [ "$MOCK_DETACHED" != 1 ] && echo main ;;
  *" rev-parse --abbrev-ref --symbolic-full-name "*) [ "$MOCK_NO_UPSTREAM" != 1 ] && echo origin/main ;;
  *" status --porcelain --untracked-files=no "*) if [ "$MOCK_DIRTY_CHECKOUT" = 1 ]; then echo ' M deploy/deploy.sh'; fi ;;
  *" pull --ff-only "*)
    [ "$MOCK_PULL_FAILURE" != 1 ] || exit 1
    if [ "$MOCK_REWRITE_UPDATE" = 1 ]; then printf '%12000s\\nexit 99\\n' '' > deploy/update.sh; fi
    if [ "$MOCK_REWRITE_DEPLOY" = 1 ]; then printf 'exit 37\\n' > deploy/deploy.sh; fi ;;
  *" rev-parse @{upstream} "*) if [ "$MOCK_AHEAD" = 1 ]; then printf '%040d\\n' 1; else printf '%040d\\n' 0; fi ;;
  *" rev-parse HEAD "*) printf '%040d\\n' 0 ;;
  *" rev-parse --short HEAD "*) echo 0000000 ;;
  *) echo https://github.com/owner/repository.git ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, 'curl'), `#!/usr/bin/env bash
[ "$MOCK_MISSING_RELEASE" != 1 ] || exit 22
while [ "$#" -gt 0 ]; do if [ "$1" = --output ]; then output="$2"; shift 2; else url="$1"; shift; fi; done
case "$url" in
  */SHA256SUMS) printf image-data | sha256sum | awk '{ print $1 "  gonglun-linux-amd64.tar.gz" }' > "$output" ;;
  *) if [ "$MOCK_CORRUPT_IMAGE" = 1 ]; then printf damaged > "$output"; else printf image-data > "$output"; fi ;;
esac
`, { mode: 0o755 });
  const result = spawnSync(bash, ['-c', `
if command -v cygpath >/dev/null 2>&1; then bin=$(cygpath -u "$1"); script=$(cygpath -u "$2"); log=$(cygpath -u "$3"); else bin="$1"; script="$2"; log="$3"; fi
shift 3; export PATH="$bin:$PATH" DOCKER_TEST_LOG="$log"; exec bash "$script" "$@"
`, 'deployment-test', bin, join(deployment, entry), log, ...flags], { encoding: 'utf8', timeout: 20000, env: { ...process.env, ...overrides } });
  assert.equal(readFileSync(join(deployment, '.env.prod'), 'utf8'), 'POSTGRES_PASSWORD=keep-existing-password\nGONGLUN_DATABASE_NAME=existing-final\n');
  assert.equal(readFileSync(join(directory, '.env.migration'), 'utf8'), 'MIGRATION_TARGET_DATABASE_URL=keep-existing-migrated-target\n');
  const commands = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => line.split('\t').filter(Boolean)) : [];
  const marker = existsSync(join(deployment, '.env.image'));
  return { ...result, commands, marker, markerContents: marker ? readFileSync(join(deployment, '.env.image'), 'utf8') : undefined };
}

test('download, checksum and load precede read-only preflight and detached API replacement', t => {
  const result = deploy(t, ['--rehearsal']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const load = result.commands.findIndex(args => args[0] === 'load');
  const check = result.commands.findIndex(args => args.includes('--check'));
  const updates = result.commands.filter(args => args.includes('up'));
  assert.ok(load >= 0 && check > load); assert.equal(updates.length, 1);
  assert.ok(updates[0].includes('--no-deps') && updates[0].includes('--no-build') && updates[0].includes('-d'));
  assert.equal(updates[0].at(-1), 'api'); assert.ok(result.marker);
  assert.ok(!result.commands.some(args => args.includes('down') || args.includes('build') || args.includes('--volumes')));
});

for (const [scenario, environment] of Object.entries({ 'missing original PostgreSQL': { MOCK_NO_DATABASE: '1' }, 'bad target': { MOCK_BAD_TARGET: '1' }, 'corrupted download': { MOCK_CORRUPT_IMAGE: '1' }, 'unfinished GitHub build': { MOCK_MISSING_RELEASE: '1' } })) {
  test(`deployment stops before replacing services: ${scenario}`, t => {
    const result = deploy(t, ['--rehearsal'], environment);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.ok(!result.commands.some(args => args.includes('up'))); assert.equal(result.marker, false);
    if (scenario === 'corrupted download') assert.ok(!result.commands.some(args => args[0] === 'load'));
  });
}

test('an explicit rollback reuses the retained local image without downloading or building', t => {
  const result = deploy(t, ['--rehearsal', '--image', 'gonglun:previous'], { MOCK_LOCAL_IMAGE: '1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(!result.commands.some(args => ['load', 'info'].includes(args[0])));
  assert.ok(result.commands.some(args => args.includes('--check')));
});

test('one-command production update pulls before deployment and verifies the running revision and health', t => {
  const result = deploy(t, [], { MOCK_PREVIOUS_DEPLOYMENT: '1', MOCK_REWRITE_UPDATE: '1' }, 'update.sh');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const pull = result.commands.findIndex(args => args[0] === 'git' && args.includes('pull'));
  const firstDocker = result.commands.findIndex(args => args[0] !== 'git');
  const check = result.commands.findIndex(args => args.includes('--check'));
  const updates = result.commands.filter(args => args.includes('up'));
  const health = result.commands.findIndex(args => args.includes('exec') && args.some(arg => arg.includes('/api/health')));
  assert.ok(pull >= 0 && firstDocker > pull && check > pull);
  assert.deepEqual(updates.map(args => args.at(-1)), ['api', 'caddy']);
  assert.ok(health > result.commands.indexOf(updates.at(-1)));
  assert.ok(result.commands.some(args => args[0] === 'inspect' && args.includes('{{.Config.Image}}')));
  assert.match(result.stdout, /Previous deployment:\nGONGLUN_IMAGE=gonglun:previous/);
  assert.match(result.stdout, /Production update and checks passed/);
  assert.equal(result.markerContents, `GONGLUN_IMAGE=gonglun:sha-${'0'.repeat(40)}\nGONGLUN_DEPLOY_MODE=production\n`);
  assert.ok(!result.commands.some(args => args.includes('down') || args.includes('build') || args.includes('--volumes')));
});

for (const [scenario, environment] of Object.entries({
  'detached checkout': { MOCK_DETACHED: '1' },
  'no upstream branch': { MOCK_NO_UPSTREAM: '1' },
  'local tracked edits': { MOCK_DIRTY_CHECKOUT: '1' },
  'failed fast-forward pull': { MOCK_PULL_FAILURE: '1' },
  'local commits ahead of upstream': { MOCK_AHEAD: '1' },
})) {
  test(`one-command update stops before deployment: ${scenario}`, t => {
    const result = deploy(t, [], environment, 'update.sh');
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.commands.every(args => args[0] === 'git'));
    assert.equal(result.marker, false);
    assert.match(result.stderr, /Production update failed during:/);
  });
}

test('one-command update opens the newly pulled deployment script', t => {
  const result = deploy(t, [], { MOCK_REWRITE_DEPLOY: '1' }, 'update.sh');
  assert.equal(result.status, 37, result.stdout + result.stderr);
  assert.ok(result.commands.every(args => args[0] === 'git'));
  assert.match(result.stderr, /failed during: deploying production/);
});

test('one-command update preserves the previous deployment record when the image is unpublished', t => {
  const result = deploy(t, [], { MOCK_MISSING_RELEASE: '1', MOCK_PREVIOUS_DEPLOYMENT: '1' }, 'update.sh');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(!result.commands.some(args => args.includes('up') || args.includes('exec')));
  assert.equal(result.markerContents, 'GONGLUN_IMAGE=gonglun:previous\nGONGLUN_DEPLOY_MODE=production\n');
  assert.match(result.stderr, /failed during: deploying production/);
});

for (const [scenario, environment] of Object.entries({
  'missing API container': { MOCK_MISSING_API: '1' },
  'unhealthy API': { MOCK_UNHEALTHY: 'api' },
  'unhealthy proxy': { MOCK_UNHEALTHY: 'caddy' },
  'wrong running image': { MOCK_WRONG_IMAGE: '1' },
  'failed health request': { MOCK_HEALTH_FAILURE: '1' },
})) {
  test(`one-command update does not report success after a failed final check: ${scenario}`, t => {
    const result = deploy(t, [], environment, 'update.sh');
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.ok(result.commands.some(args => args.includes('up')));
    assert.match(result.stderr, /failed during: checking the deployment/);
    assert.doesNotMatch(result.stdout, /Production update and checks passed/);
  });
}
