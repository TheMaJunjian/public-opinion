import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { synchronize, connectionLabel, localBackups, updateEnvContents, validateRemote, verifyBackup } from './sync-vps-db.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const original = '# local settings\r\nDATABASE_URL=postgresql://gonglun:private-test-password@127.0.0.1:54329/original\r\nDATABASE_SCHEMA=public\r\nPORT=3000\r\n';
const metadata = 'database=production_source\nschema=business\nimage=gonglun:sha-example\ncreated_at_utc=2026-10-20T11:15:04Z\n';
function archive(directory, contents = 'test-archive') {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'database.dump'), contents);
  writeFileSync(join(directory, 'metadata.txt'), metadata);
  writeFileSync(join(directory, 'SHA256SUMS'), `${digest(contents)}  database.dump\n${digest(metadata)}  metadata.txt\n`);
  return join(directory, 'database.dump');
}
function fixture(t, { answers = ['2', '', '1', '', 'new_target', 'y'], failure, endpoint = 'npipe:////./pipe/test-docker', verify, remoteFiles } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'gonglun-vps-sync-test-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('gonglun-vps-sync-test-'));
    rmSync(directory, { recursive: true, force: true });
  });
  mkdirSync(join(directory, 'deploy/backups'), { recursive: true });
  writeFileSync(join(directory, '.env'), original);
  const file = archive(join(directory, 'deploy/backups/completed'));
  const calls = [], logs = [], prompts = [];
  const remoteRoot = '/srv/gonglun/deploy/backups/snapshot';
  const remote = remoteFiles || [`${remoteRoot}/database.dump`, `${remoteRoot}/metadata.txt`, `${remoteRoot}/SHA256SUMS`];
  const queue = [...answers];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'ssh') {
      if (failure === 'ssh') throw new Error('ssh failed');
      return args.includes('-t') ? '' : remote.join('\0');
    }
    if (command === 'sftp') {
      const batch = readFileSync(join(options.cwd, args[args.indexOf('-b') + 1]), 'utf8');
      calls.at(-1).batch = batch;
      for (const line of batch.trim().split('\n')) {
        if (line === 'bye') continue;
        const get = /^get "([^"]+)" "([^"]+)"$/.exec(line);
        assert.ok(get, `Invalid SFTP command: ${line}`);
        assert.equal(get[2], posix.basename(get[1]));
        copyFileSync(join(dirname(file), get[2]), join(options.cwd, get[2]));
      }
      if (failure === 'sftp') throw new Error('download failed');
      if (failure === 'download-checksum') writeFileSync(join(options.cwd, 'database.dump'), 'damaged');
      return '';
    }
    assert.equal(command, 'docker');
    if (args[0] === 'context') return args[1] === 'show' ? 'desktop-test\n' : JSON.stringify(endpoint);
    assert.ok(args.includes('--context') && args.includes('desktop-test'));
    assert.equal(args[args.indexOf('--project-name') + 1], 'gonglun-dev');
    assert.equal(args[args.indexOf('-f') + 1], join(directory, 'deploy/docker-compose.dev.yml'));
    if (args.includes('up') && failure === 'start') throw new Error('start failed');
    if (args.includes('psql')) return failure === 'existing' ? '1\n' : '';
    if (args.includes('pg_restore') && args.includes('--list') && failure === 'archive') throw new Error('invalid archive');
    if (args.includes('--single-transaction') && failure === 'restore') throw new Error('restore failed');
    assert.ok(!args.some(arg => ['dropdb', 'down', '--clean', 'prune'].includes(arg)));
    return '';
  };
  const start = () => synchronize({
    repoRoot: directory, run, log: value => logs.push(value),
    ask: async (label, fallback) => {
      prompts.push({ label, fallback });
      assert.ok(queue.length, `Unexpected prompt: ${label}`);
      return queue.shift() || fallback;
    },
    verifyDatabase: async configuration => {
      assert.match(configuration.url, /^postgresql:\/\/gonglun:gonglun_dev@127\.0\.0\.1:54329\//);
      assert.equal(configuration.schema, 'business');
      if (failure === 'verify') throw new Error('incompatible database');
      await verify?.(configuration, directory);
      return { ...configuration, users: 2 };
    },
  });
  return { directory, file, calls, logs, prompts, queue, start };
}

test('local restore verifies the selected archive and changes only database settings after confirmation', async t => {
  const f = fixture(t);
  const result = await f.start();
  assert.equal(result.switched, true);
  assert.equal(readFileSync(result.previous, 'utf8'), original);
  const current = readFileSync(join(f.directory, '.env'), 'utf8');
  assert.match(current, /DATABASE_URL=postgresql:\/\/gonglun:gonglun_dev@127.0.0.1:54329\/new_target\r\nDATABASE_SCHEMA=business\r\nPORT=3000/);
  assert.ok(!f.logs.join('\n').includes('private-test-password'));
  const create = f.calls.findIndex(call => call.args.includes('createdb'));
  const restore = f.calls.findIndex(call => call.args.includes('--single-transaction'));
  assert.ok(create >= 0 && restore > create);
  assert.ok(f.calls[create].args.includes('template0'));
  assert.ok(f.calls[restore].args.includes('--exit-on-error'));
  assert.ok(f.calls.at(-1).args.includes('rm'));
});

test('cancelling the switch keeps the restored database and the old .env', async t => {
  const f = fixture(t, { answers: ['2', '', '1', '', 'new_target', 'n'] });
  const result = await f.start();
  assert.equal(result.switched, false);
  assert.ok(f.calls.some(call => call.args.includes('--single-transaction')));
  assert.equal(readFileSync(join(f.directory, '.env'), 'utf8'), original);
  assert.ok(!readdirSync(f.directory).some(name => name.startsWith('.env.before-vps-sync-')));
});

for (const failure of ['start', 'existing', 'archive', 'restore', 'verify']) {
  test(`failure never switches .env or removes a database: ${failure}`, async t => {
    const f = fixture(t, { failure });
    await assert.rejects(f.start());
    assert.equal(readFileSync(join(f.directory, '.env'), 'utf8'), original);
    assert.ok(!f.calls.some(call => call.args.includes('dropdb') || call.args.includes('--clean')));
    if (['start', 'existing', 'archive'].includes(failure)) assert.ok(!f.calls.some(call => call.args.includes('createdb')));
  });
}

test('a concurrent edit of .env is preserved instead of replaced', async t => {
  const f = fixture(t, { verify: (_, directory) => writeFileSync(join(directory, '.env'), `${original}CUSTOM=edited\n`) });
  await assert.rejects(f.start(), /操作期间发生变化/);
  assert.equal(readFileSync(join(f.directory, '.env'), 'utf8'), `${original}CUSTOM=edited\n`);
});

for (const what of ['archive', 'metadata', 'missing checksum']) {
  test(`invalid local backup stops before Docker: ${what}`, async t => {
    const f = fixture(t);
    if (what === 'missing checksum') rmSync(join(dirname(f.file), 'SHA256SUMS'));
    else writeFileSync(what === 'archive' ? f.file : join(dirname(f.file), 'metadata.txt'), 'damaged');
    await assert.rejects(f.start(), /校验|缺少/);
    assert.deepEqual(f.calls, []);
    assert.equal(readFileSync(join(f.directory, '.env'), 'utf8'), original);
  });
}

test('remote Docker contexts are refused before starting any database', async t => {
  const f = fixture(t, { endpoint: 'tcp://production.example:2376' });
  await assert.rejects(f.start(), /远程地址/);
  assert.ok(!f.calls.some(call => call.args.includes('compose')));
});

for (const [schema, database] of [['bad;drop', 'new_target'], ['business', 'postgres'], ['business', "bad';drop"]]) {
  test(`invalid restore identifiers stop before Docker: ${schema}/${database}`, async t => {
    const f = fixture(t, { answers: ['2', '', '1', schema, database, 'y'] });
    await assert.rejects(f.start(), /名称无效|数据库名无效/);
    assert.deepEqual(f.calls, []);
  });
}

const remoteAnswers = (action = '1') => [action, '', 'vps.example', '44333', 'root', '/srv/gonglun/deploy', '/srv/gonglun/deploy/backups', '1', '', 'remote_target', 'y'];
test('remote selection uses one SFTP session for the archive and sidecars, then verifies and restores it', async t => {
  const f = fixture(t, { answers: remoteAnswers() });
  const result = await f.start();
  assert.equal(result.switched, true);
  const transfers = f.calls.filter(call => call.command === 'sftp');
  assert.equal(transfers.length, 1);
  const transfer = transfers[0];
  assert.deepEqual(transfer.args, ['-oBatchMode=no', '-b', 'download.sftp', '-P', '44333', 'root@vps.example']);
  assert.deepEqual(transfer.batch.trim().split('\n'), [
    'get "/srv/gonglun/deploy/backups/snapshot/database.dump" "database.dump"',
    'get "/srv/gonglun/deploy/backups/snapshot/SHA256SUMS" "SHA256SUMS"',
    'get "/srv/gonglun/deploy/backups/snapshot/metadata.txt" "metadata.txt"',
    'bye',
  ]);
  assert.ok(!result.file.includes('.partial.'));
  assert.equal(readFileSync(result.file, 'utf8'), 'test-archive');
  assert.equal(existsSync(join(dirname(result.file), 'download.sftp')), false);
  const saved = JSON.parse(readFileSync(join(f.directory, '.env.vps-sync.json'), 'utf8'));
  assert.equal(saved.port, '44333');
  assert.equal(saved.host, 'vps.example');
  assert.ok(!JSON.stringify(saved).includes('password'));
  assert.ok(f.calls.findIndex(call => call.command === 'sftp') < f.calls.findIndex(call => call.args.includes('createdb')));
});

const nativeSftpServer = process.platform === 'win32' ? join(process.env.WINDIR || 'C:/Windows', 'System32/OpenSSH/sftp-server.exe') : '/usr/lib/openssh/sftp-server';
for (const missing of [false, true]) {
  test(`native SFTP executes one batch and aborts on a missing file: ${missing}`, { skip: !existsSync(nativeSftpServer) }, async t => {
    const f = fixture(t, { answers: remoteAnswers() });
    await f.start();
    const transfer = f.calls.find(call => call.command === 'sftp');
    const target = join(f.directory, 'native sftp');
    mkdirSync(target);
    const source = dirname(f.file).replaceAll('\\', '/');
    let batch = transfer.batch.replaceAll('/srv/gonglun/deploy/backups/snapshot', source);
    if (missing) batch = batch.replace(`${source}/SHA256SUMS`, `${source}/not-present`);
    const batchFile = join(target, 'batch.sftp');
    writeFileSync(batchFile, batch);
    const result = spawnSync('sftp', ['-oBatchMode=no', '-b', batchFile, '-D', nativeSftpServer], {
      cwd: target, encoding: 'utf8', timeout: 20000, windowsHide: true,
    });
    if (missing) {
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(join(target, 'database.dump'), 'utf8'), 'test-archive');
      assert.equal(existsSync(join(target, 'metadata.txt')), false);
    } else {
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal((await verifyBackup(join(target, 'database.dump'))).schema, 'business');
    }
  });
}

test('OpenSSH keeps the explicit password-enabled BatchMode before the batch default', t => {
  const result = spawnSync('ssh', ['-G', '-F', 'none', '-oBatchMode=no', '-oBatchMode=yes', 'example.invalid'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  if (result.error?.code === 'ENOENT') { t.skip('OpenSSH is not installed on this test host.'); return; }
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^batchmode no\r?$/m);
});

test('fresh backup action runs only the existing online backup entry before listing remote backups', async t => {
  const f = fixture(t, { answers: remoteAnswers('3') });
  await f.start();
  const ssh = f.calls.filter(call => call.command === 'ssh');
  assert.equal(ssh.length, 2);
  assert.ok(ssh[0].args.includes('-t'));
  assert.equal(ssh[0].args.at(-1), "bash '/srv/gonglun/deploy/manage.sh' backup");
  assert.ok(ssh[1].args.at(-1).startsWith("find '/srv/gonglun/deploy/backups'"));
  assert.ok(!ssh[0].args.at(-1).includes('stop'));
});

test('the remote listing command works in Bash and prunes incomplete directories', async t => {
  const f = fixture(t, { answers: remoteAnswers() });
  archive(join(f.directory, 'deploy/backups/interrupted.partial.123'));
  await f.start();
  const command = f.calls.find(call => call.command === 'ssh' && !call.args.includes('-t')).args.at(-1)
    .replace("'/srv/gonglun/deploy/backups'", "'deploy/backups'");
  const bash = process.platform === 'win32' ? resolve(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), '../../../bin/bash.exe') : 'bash';
  const listing = execFileSync(bash, ['-c', `
if command -v cygpath >/dev/null 2>&1; then root=$(cygpath -u "$1"); else root="$1"; fi
cd "$root" || exit 1
${command}
`, 'remote-list-test', f.directory], { encoding: 'utf8' });
  assert.ok(listing.includes('deploy/backups/completed/database.dump\0'));
  assert.ok(!listing.includes('interrupted.partial.123'));
});

for (const failure of ['ssh', 'sftp', 'download-checksum']) {
  test(`failed remote download cannot reach restoration: ${failure}`, async t => {
    const f = fixture(t, { answers: remoteAnswers(), failure });
    await assert.rejects(f.start());
    assert.ok(!f.calls.some(call => call.command === 'docker'));
    assert.equal(readFileSync(join(f.directory, '.env'), 'utf8'), original);
    if (failure !== 'ssh') assert.ok(readdirSync(join(f.directory, 'deploy/backups')).some(name => name.includes('.partial.')));
    const transfer = f.calls.find(call => call.command === 'sftp');
    if (transfer) assert.equal(existsSync(join(transfer.options.cwd, 'download.sftp')), false);
  });
}

test('remote paths outside the selected backup root are rejected before SFTP', async t => {
  const f = fixture(t, { answers: remoteAnswers(), remoteFiles: ['/etc/database.dump', '/etc/SHA256SUMS'] });
  await assert.rejects(f.start(), /目录以外/);
  assert.ok(!f.calls.some(call => call.command === 'sftp' || call.command === 'docker'));
});

test('cancelled local backup selection never contacts Docker', async t => {
  const f = fixture(t, { answers: ['2', '', '0'] });
  assert.equal((await f.start()).switched, false);
  assert.deepEqual(f.calls, []);
});

test('invalid local backup selection never contacts Docker', async t => {
  const f = fixture(t, { answers: ['2', '', '99999999999999999999999'] });
  await assert.rejects(f.start(), /序号无效/);
  assert.deepEqual(f.calls, []);
});

test('remembered connection settings are reused as prompt defaults', async t => {
  const f = fixture(t, { answers: ['1', '', '', '', '', '', '', '0'] });
  writeFileSync(join(f.directory, '.env.vps-sync.json'), JSON.stringify({ host: 'saved.example', port: '44333', user: 'saved', deployDir: '/saved/deploy', backupDir: '/srv/gonglun/deploy/backups' }));
  assert.equal((await f.start()).switched, false);
  assert.ok(f.prompts.some(item => item.label === 'VPS 地址' && item.fallback === 'saved.example'));
  assert.ok(f.prompts.some(item => item.label === 'SSH 端口' && item.fallback === '44333'));
});

test('local discovery skips incomplete exports and preserves paths with spaces and Unicode', t => {
  const f = fixture(t);
  archive(join(f.directory, 'deploy/backups/中文 空格'));
  archive(join(f.directory, 'deploy/backups/interrupted.partial.123'));
  const files = localBackups(join(f.directory, 'deploy/backups'));
  assert.equal(files.length, 2);
  assert.ok(files.some(file => file.includes('中文 空格')));
  assert.ok(files.every(file => !file.includes('.partial.')));
});

test('moved single-file checksum remains usable', async t => {
  const f = fixture(t);
  rmSync(join(dirname(f.file), 'SHA256SUMS'));
  writeFileSync(`${f.file}.sha256`, `${digest('test-archive')}  /old-server/database.dump\n`);
  assert.equal((await verifyBackup(f.file)).schema, 'business');
});

test('connection labels never reveal credentials', () => {
  assert.equal(connectionLabel('postgresql://user:secret@127.0.0.1:54329/example'), '127.0.0.1:54329/example');
  assert.equal(connectionLabel('bad secret'), '连接配置无法解析');
});

test('env update removes duplicate connection keys while preserving unrelated settings and line endings', () => {
  const updated = updateEnvContents('export DATABASE_URL=old\r\n# keep\r\nDATABASE_URL=duplicate\r\nOTHER=value\r\n', 'new-url', 'business');
  assert.equal(updated, 'DATABASE_URL=new-url\r\n# keep\r\nOTHER=value\r\nDATABASE_SCHEMA=business\r\n');
});

test('remote parameters cannot become shell options or commands', () => {
  const valid = { host: 'vps.example', port: '44333', user: 'root', deployDir: '/srv/deploy', backupDir: '/srv/deploy/backups' };
  for (const invalid of [{ host: '-oProxyCommand=bad' }, { port: '0' }, { port: '65536' }, { user: 'root;bad' }, { deployDir: '/srv/$(bad)' }, { backupDir: '/srv/../etc' }]) {
    assert.throws(() => validateRemote({ ...valid, ...invalid }));
  }
});

for (const action of ['switch', 'cancel', 'fail']) {
  test(`PowerShell clears parent connection overrides only after a successful switch: ${action}`, { skip: process.platform !== 'win32' }, t => {
    const f = fixture(t);
    copyFileSync(resolve('deploy/sync-vps-db.ps1'), join(f.directory, 'deploy/sync-vps-db.ps1'));
    const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `
$env:DATABASE_URL = 'old-override'
$env:DATABASE_SCHEMA = 'old-schema'
function node {
  if ($env:SYNC_WRAPPER_TEST_ACTION -eq 'switch') {
    [IO.File]::WriteAllText((Join-Path $env:SYNC_WRAPPER_TEST_ROOT '.env'), 'DATABASE_URL=new-value')
  }
  $global:LASTEXITCODE = if ($env:SYNC_WRAPPER_TEST_ACTION -eq 'fail') { 1 } else { 0 }
}
$caught = $false
try { & (Join-Path $env:SYNC_WRAPPER_TEST_ROOT 'deploy/sync-vps-db.ps1') } catch { $caught = $true }
@{ url = $env:DATABASE_URL; schema = $env:DATABASE_SCHEMA; caught = $caught } | ConvertTo-Json -Compress
`], {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, SYNC_WRAPPER_TEST_ROOT: f.directory, SYNC_WRAPPER_TEST_ACTION: action },
    });
    assert.equal(result.status, 0, result.stderr);
    const state = JSON.parse(result.stdout);
    if (action === 'switch') { assert.equal(state.url, null); assert.equal(state.schema, null); }
    else { assert.equal(state.url, 'old-override'); assert.equal(state.schema, 'old-schema'); }
    assert.equal(state.caught, action === 'fail');
  });
}
