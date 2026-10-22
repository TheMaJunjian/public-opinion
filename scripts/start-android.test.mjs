import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { ensureService, instanceRunning, lockLaunch, waitUntil } from './start-android.mjs';

test('an existing healthy service is reused without preparing its database or starting a second process', async () => {
  const unexpected = async () => assert.fail('A healthy service must not be restarted');
  assert.equal(await ensureService({ name: 'test', ready: async () => true,
    occupied: unexpected, prepare: unexpected, start: unexpected, wait: unexpected }), 'reused');
});

test('an occupied port waits for the existing startup instead of launching a duplicate', async () => {
  let checks = 0;
  const unexpected = async () => assert.fail('An occupied port must not trigger another process');
  assert.equal(await ensureService({ name: 'test', ready: async () => ++checks >= 3,
    occupied: async () => true, prepare: unexpected, start: unexpected,
    wait: (check, message) => waitUntil(check, message, 100, 1) }), 'reused');
  assert.ok(checks >= 3);
});

test('a cold service prepares its database before spawning and waits for readiness', async () => {
  const events = [];
  let ready = false;
  const child = { exitCode: null, signalCode: null };
  assert.equal(await ensureService({ name: 'test', ready: async () => ready,
    occupied: async () => false, prepare: async () => events.push('database'),
    start: async () => { events.push('spawn'); return child; },
    wait: async check => {
      assert.equal(await check(), false);
      ready = true;
      assert.equal(await check(), true);
      events.push('ready');
    } }), 'started');
  assert.deepEqual(events, ['database', 'spawn', 'ready']);
});

test('failed database preparation never starts the backend', async () => {
  await assert.rejects(ensureService({ name: 'test', ready: async () => false,
    occupied: async () => false, prepare: async () => { throw new Error('database failed'); },
    start: async () => assert.fail('Do not start without the database') }), /database failed/);
});

test('an exited child fails promptly rather than reporting success or waiting for the full timeout', async () => {
  await assert.rejects(ensureService({ name: 'test', ready: async () => false,
    occupied: async () => false, start: async () => ({ exitCode: 1, signalCode: null }),
    wait: (check, message) => waitUntil(check, message, 100, 1) }), /启动失败/);
});

test('unready services time out with a useful diagnostic', async () => {
  await assert.rejects(ensureService({ name: '测试服务', ready: async () => false,
    occupied: async () => true, start: async () => assert.fail('port is already occupied'),
    wait: (check, message) => waitUntil(check, message, 10, 1) }), /测试服务未能就绪.*端口/);
});

test('instance selection uses the requested index even with commas in emulator names', () => {
  const instances = '0,Office, test,2300972,35459098,1,72732,43924,1920,1080,280\r\n1,Other,0,0,0,-1,-1,1920,1080,280';
  assert.equal(instanceRunning(instances, 0), true);
  assert.equal(instanceRunning(instances, 1), false);
  assert.throws(() => instanceRunning(instances, 2), /没有编号为 2/);
});

test('double-clicks share one launch and a crash does not leave the launcher permanently locked', t => {
  const directory = mkdtempSync(join(tmpdir(), 'gonglun-android-start-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true });
  });
  const unlock = lockLaunch(directory);
  assert.equal(typeof unlock, 'function');
  assert.equal(lockLaunch(directory), null);
  unlock();
  const exitedPid = execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).trim();
  writeFileSync(join(directory, 'launch.lock'), exitedPid);
  const recovered = lockLaunch(directory);
  assert.equal(typeof recovered, 'function');
  recovered();
});
