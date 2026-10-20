import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const bash = process.platform === 'win32' ? resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/bash.exe') : 'bash';
const oldImage = `gonglun:sha-${'1'.repeat(40)}`;
const otherImage = `gonglun:sha-${'3'.repeat(40)}`;
function maintain(t, action, answers, env = {}, prepare = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'gonglun-maintenance-test-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('gonglun-maintenance-test-'));
    rmSync(directory, { recursive: true, force: true });
  });
  const deployment = join(directory, 'deploy'), bin = join(directory, 'bin'), log = join(directory, 'commands.log');
  mkdirSync(deployment); mkdirSync(bin);
  copyFileSync(resolve('deploy/manage.sh'), join(deployment, 'manage.sh'));
  writeFileSync(join(deployment, '.env.prod'), 'preserve-existing-credentials\n');
  writeFileSync(join(directory, 'backup.dump'), 'archive-data');
  prepare(directory, deployment);
  writeFileSync(join(bin, 'docker'), String.raw`#!/usr/bin/env bash
printf '%s\t' "$@" >> "$MOCK_LOG"; printf '\n' >> "$MOCK_LOG"
case "$1" in
  inspect) if [ "$3" = '{{.Config.Image}}' ]; then printf 'gonglun:sha-%040d\n' 2; else echo true; fi ;;
  ps)
    if [ "$MOCK_USED_IMAGE" = 1 ] || [[ "$*" = *"$MOCK_USED_TAG"* && -n "$MOCK_USED_TAG" ]]; then echo current-container; fi
    if [ "$MOCK_USED_AFTER_CONFIRM" = 1 ]; then
      if [ -f "$MOCK_LOG.checked" ]; then echo new-container; else touch "$MOCK_LOG.checked"; fi
    fi ;;
  image)
    if [ "$2" = ls ]; then
      [ "$MOCK_LIST_FAIL" != 1 ] || exit 1
      if [ "$MOCK_NO_IMAGES" != 1 ]; then
        printf '%s\told-id\t100MB\n' '${oldImage}'
        printf 'gonglun:sha-%040d\tcurrent-id\t101MB\n' 2
        printf '%s\tother-id\t99MB\n' '${otherImage}'
        printf 'gonglun:latest\tother-tag\t99MB\n'
      fi
    fi ;;
  compose)
    case " $* " in
      *" ps -q postgres "*) [ "$MOCK_NO_DB" = 1 ] || echo postgres-container ;;
      *" ps -aq api "*) echo api-container ;;
      *" exec -T api node "*)
        [ "$MOCK_OFFLINE_API" != 1 ] || exit 1
        if [ "$MOCK_REHEARSAL" = 1 ]; then printf 'verified_rehearsal\tbusiness\trehearsal\n'; else printf 'actual_final\tpublic\tproduction\n'; fi ;;
      *" pg_dump "*) printf archive-data; [ "$MOCK_DUMP_FAIL" != 1 ] ;;
      *" pg_restore --list "*) cat >/dev/null; [ "$MOCK_ARCHIVE_FAIL" != 1 ] ;;
      *" pg_restore "*) cat >/dev/null; [ "$MOCK_RESTORE_FAIL" != 1 ] ;;
      *" SELECT 1 FROM pg_database "*) if [ "$MOCK_EXISTING" = 1 ]; then echo 1; fi ;;
      *" SELECT current_database()"*) echo 'restored|15' ;;
    esac ;;
esac
`, { mode: 0o755 });
  const result = spawnSync(bash, ['-c', String.raw`
if command -v cygpath >/dev/null 2>&1; then bin=$(cygpath -u "$1"); root=$(cygpath -u "$2"); else bin="$1"; root="$2"; fi
shift 2; export PATH="$bin:$PATH" MOCK_LOG="$root/commands.log"; cd "$root"; exec bash deploy/manage.sh "$@"
`, 'maintenance-test', bin, directory, ...(action ? [action] : [])], {
    encoding: 'utf8', input: answers, timeout: 20000, env: { ...process.env, ...env },
  });
  assert.equal(readFileSync(join(deployment, '.env.prod'), 'utf8'), 'preserve-existing-credentials\n');
  const commands = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => line.split('\t').filter(Boolean)) : [];
  assert.ok(!commands.some(args => ['down', 'dropdb', '--clean', '--force', '-f', 'prune', 'stop', 'up'].some(word => args.includes(word) && !(word === '-f' && args[0] === 'compose'))));
  return { ...result, commands, directory, deployment };
}

test('backup detects the live target and publishes a private archive with checksums', t => {
  const result = maintain(t, 'backup', '\n\n\n');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const dump = result.commands.find(args => args.includes('pg_dump'));
  assert.equal(dump[dump.indexOf('-d') + 1], 'actual_final');
  const backups = join(result.deployment, 'backups');
  const folders = readdirSync(backups);
  assert.equal(folders.length, 1); assert.ok(!folders[0].includes('.partial.'));
  assert.equal(readFileSync(join(backups, folders[0], 'database.dump'), 'utf8'), 'archive-data');
  assert.match(readFileSync(join(backups, folders[0], 'SHA256SUMS'), 'utf8'), /database.dump/);
  assert.match(readFileSync(join(backups, folders[0], 'metadata.txt'), 'utf8'), /schema=public\nimage=gonglun:sha-0{39}2/);
  assert.match(result.stdout, /备份成功/);
  assert.match(result.stdout, /当前数据库：actual_final/);
  assert.match(result.stdout, /当前 schema：public/);
  assert.match(result.stdout, /应用镜像：gonglun:sha-0{39}2/);
});

for (const env of [{ MOCK_DUMP_FAIL: '1' }, { MOCK_ARCHIVE_FAIL: '1' }]) {
  test(`incomplete backups stay marked partial: ${JSON.stringify(env)}`, t => {
    const result = maintain(t, 'backup', '\n\n\n', env);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /备份成功/);
    assert.ok(readdirSync(join(result.deployment, 'backups')).every(name => name.includes('.partial.')));
  });
}

test('an offline API never causes fallback to the default database', t => {
  const result = maintain(t, 'backup', '\n\n', { MOCK_OFFLINE_API: '1' });
  assert.notEqual(result.status, 0);
  assert.ok(!result.commands.some(args => args.includes('pg_dump')));
  assert.match(result.stdout, /当前数据库：未能确认/);
});

test('rehearsal overview and backup use the actual rehearsal database and schema', t => {
  const result = maintain(t, 'backup', '\n\n\n', { MOCK_REHEARSAL: '1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /运行模式：rehearsal/);
  assert.match(result.stdout, /当前数据库：verified_rehearsal/);
  assert.match(result.stdout, /当前 schema：business/);
  const dump = result.commands.find(args => args.includes('pg_dump'));
  assert.equal(dump[dump.indexOf('-d') + 1], 'verified_rehearsal');
});

test('restore works with offline API and uses a new database and one atomic transaction', t => {
  const result = maintain(t, 'restore', '\nbackup.dump\nrestored_target\n', { MOCK_OFFLINE_API: '1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const create = result.commands.findIndex(args => args.includes('createdb'));
  const restore = result.commands.findIndex(args => args.includes('pg_restore') && args.includes('-d'));
  assert.ok(create >= 0 && restore > create);
  assert.ok(result.commands[restore].includes('--single-transaction'));
  assert.ok(result.commands[restore].includes('--exit-on-error'));
  assert.ok(result.commands[create].includes('template0'));
  assert.match(result.stdout, /尚未切换网站/);
  assert.match(result.stdout, /GONGLUN_DATABASE_NAME 设置为 restored_target/);
});

for (const [name, env, target] of [
  ['existing target', { MOCK_EXISTING: '1' }, 'existing_target'],
  ['invalid target', {}, "bad';DROP DATABASE postgres;--"],
  ['system target', {}, 'postgres'],
  ['unreadable archive', { MOCK_ARCHIVE_FAIL: '1' }, 'new_target'],
  ['missing PostgreSQL', { MOCK_NO_DB: '1' }, 'new_target'],
]) {
  test(`restore refuses before creating a database: ${name}`, t => {
    const result = maintain(t, 'restore', `\nbackup.dump\n${target}\n`, env);
    assert.notEqual(result.status, 0);
    assert.ok(!result.commands.some(args => args.includes('createdb')));
  });
}

test('failed restore reports failure without switching or deleting any database', t => {
  const result = maintain(t, 'restore', '\nbackup.dump\nnew_target\n', { MOCK_RESTORE_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /恢复完成/);
  assert.match(result.stderr, /应用仍使用原库/);
});

for (const manifest of ['single', 'directory', 'corrupt', 'unrelated']) {
  test(`restore checksum validation: ${manifest}`, t => {
    const result = maintain(t, 'restore', '\nbackup.dump\nnew_target\n', {}, directory => {
      const hash = createHash('sha256').update('archive-data').digest('hex');
      if (manifest === 'single') writeFileSync(join(directory, 'backup.dump.sha256'), `${hash}  /old-server/backup.dump\n`);
      else writeFileSync(join(directory, 'SHA256SUMS'), `${manifest === 'corrupt' ? '0'.repeat(64) : hash}  ${manifest === 'unrelated' ? 'other.dump' : 'backup.dump'}\n`);
    });
    if (['corrupt', 'unrelated'].includes(manifest)) {
      assert.notEqual(result.status, 0);
      assert.ok(!result.commands.some(args => args.includes('createdb')));
    } else assert.equal(result.status, 0, result.stdout + result.stderr);
  });
}

test('image cleanup selects a numbered image and confirms once', t => {
  const result = maintain(t, 'images', '\n1\ny\n');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`1\\) ${oldImage}`));
  assert.match(result.stdout, /2\).*当前应用使用，禁止删除/);
  assert.match(result.stdout, /即将删除以下 1 个镜像/);
  assert.doesNotMatch(result.stdout, /4\) gonglun:latest/);
  assert.deepEqual(result.commands.find(args => args[0] === 'image' && args[1] === 'rm'), ['image', 'rm', oldImage]);
});

for (const selection of ['3 1 3', '3,1,3', '3，1，3']) {
  test(`image cleanup previews the whole batch and removes duplicates: ${selection}`, t => {
    const result = maintain(t, 'images', `\n${selection}\ny\n`);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /即将删除以下 2 个镜像/);
    const preview = result.stdout.slice(result.stdout.indexOf('即将删除以下'));
    assert.ok(preview.includes(oldImage) && preview.includes(otherImage));
    assert.deepEqual(result.commands.filter(args => args[0] === 'image' && args[1] === 'rm'), [['image', 'rm', otherImage, oldImage]]);
  });
}

for (const scenario of ['used', 'recorded', 'current', 'newly used']) {
  test(`image cleanup refuses ${scenario} image`, t => {
    const selected = scenario === 'current' ? '1 2' : '1';
    const result = maintain(t, 'images', `\n${selected}\ny\n`,
      scenario === 'used' ? { MOCK_USED_IMAGE: '1' } : scenario === 'newly used' ? { MOCK_USED_AFTER_CONFIRM: '1' } : {},
      (_, deployment) => { if (scenario === 'recorded') writeFileSync(join(deployment, '.env.image'), `GONGLUN_IMAGE=${oldImage}\r\n`); });
    assert.notEqual(result.status, 0);
    assert.ok(!result.commands.some(args => args[0] === 'image' && args[1] === 'rm'));
  });
}

test('a protected image anywhere in the batch prevents every deletion', t => {
  const result = maintain(t, 'images', '\n1 3\ny\n', { MOCK_USED_TAG: otherImage });
  assert.notEqual(result.status, 0);
  assert.ok(!result.commands.some(args => args[0] === 'image' && args[1] === 'rm'));
});

for (const selection of ['4', '1 999', '-1', '1;echo', '01', '9999999999999999999999999999', ',,,']) {
  test(`invalid image selection never deletes a partial batch: ${selection}`, t => {
    const result = maintain(t, 'images', `\n${selection}\ny\n`);
    assert.notEqual(result.status, 0);
    assert.ok(!result.commands.some(args => args[0] === 'image' && args[1] === 'rm'));
  });
}

for (const answers of ['\n\n', '\n0\n', '\n1\n\n', '\n1 3\nn\n']) {
  test(`image deletion can be cancelled: ${JSON.stringify(answers)}`, t => {
    const result = maintain(t, 'images', answers);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(!result.commands.some(args => args[0] === 'image' && args[1] === 'rm'));
  });
}

test('empty image list exits without prompting for selection', t => {
  const result = maintain(t, 'images', '\n', { MOCK_NO_IMAGES: '1' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /没有找到可列出/);
});

test('a failed image listing cannot lead to deletion', t => {
  const result = maintain(t, 'images', '\n1\ny\n', { MOCK_LIST_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.ok(!result.commands.some(args => args[0] === 'image' && args[1] === 'rm'));
});

test('menu cancellation needs no Docker or configuration', t => {
  const result = maintain(t, '', '\n');
  assert.equal(result.status, 0);
  assert.deepEqual(result.commands, []);
});
