import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { developmentDatabaseUrl, ensureDevelopmentDatabase, loadEnvironment } from './postgres.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const logs = join(root, 'artifacts', 'android-dev');
const page = 'http://localhost:5173/messages';
const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function run(file, args, timeout = 15_000) {
  const { stdout } = await execute(file, args, { cwd: root, encoding: 'utf8', timeout, windowsHide: true });
  return stdout.trim();
}

export async function waitUntil(check, message, timeout = 120_000, interval = 1_000) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await sleep(interval);
  } while (Date.now() < deadline);
  throw new Error(message);
}

async function healthy(url, kind = 'api') {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) return false;
    return kind === 'api' ? (await response.json()).ok === true
      : /<title>公论/.test(await response.text());
  } catch { return false; }
}

async function portOpen(port) {
  return new Promise(resolve => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1_000);
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  });
}

async function background(file, args, name, env = process.env) {
  const output = openSync(join(logs, `${name}.log`), 'a');
  try {
    const child = spawn(file, args, {
      cwd: root, env, detached: true, windowsHide: true, stdio: ['ignore', output, output],
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    return child;
  } finally { closeSync(output); }
}

export async function ensureService({ name, ready, occupied, prepare, start, wait = waitUntil }) {
  if (await ready()) return 'reused';
  let child;
  if (!(await occupied())) {
    await prepare?.();
    child = await start();
  }
  await wait(async () => {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(`${name}启动失败，请查看日志：${logs}`);
    }
    return ready();
  }, `${name}未能就绪，请检查端口占用或查看日志：${logs}`);
  return child ? 'started' : 'reused';
}

async function database() {
  if ((process.env.DATABASE_URL || developmentDatabaseUrl) === developmentDatabaseUrl) {
    try { await run('docker', ['info', '--format', '{{.ServerVersion}}'], 8_000); }
    catch {
      const desktop = join(process.env.ProgramFiles || 'C:/Program Files', 'Docker', 'Docker', 'Docker Desktop.exe');
      if (!existsSync(desktop)) throw new Error('请安装并启动 Docker Desktop，或配置 DATABASE_URL。');
      console.log('正在启动 Docker Desktop，首次启动可能需要一两分钟……');
      await background(desktop, [], 'docker-desktop');
      await waitUntil(async () => {
        try { await run('docker', ['info', '--format', '{{.ServerVersion}}'], 5_000); return true; }
        catch { return false; }
      }, 'Docker Desktop 尚未就绪，请查看 Docker 的启动状态。', 180_000, 2_000);
    }
  }
  await ensureDevelopmentDatabase();
}

async function services() {
  console.log('[1/4] 检查并启动开发服务……');
  await ensureService({
    name: '后端服务', ready: () => healthy('http://127.0.0.1:3000/api/health'),
    occupied: () => portOpen(3000), prepare: database,
    start: () => background(process.execPath, [require.resolve('tsx/cli'), 'watch', 'apps/server/src/main.ts'],
      'server', { ...process.env, NODE_ENV: 'development', HOST: '127.0.0.1', PORT: '3000' }),
  });
  await ensureService({
    name: '前端服务', ready: () => healthy('http://127.0.0.1:5173/messages', 'page'),
    occupied: () => portOpen(5173),
    start: () => background(process.execPath, [
      join(dirname(require.resolve('vite/package.json')), 'bin/vite.js'),
      '--config', 'frontend/vite.config.ts', 'frontend', '--host', '127.0.0.1', '--port', '5173', '--strictPort',
    ], 'frontend', { ...process.env, NODE_ENV: 'development' }),
  });
  await waitUntil(() => healthy('http://127.0.0.1:5173/api/health'), '开发代理无法连接后端，请检查开发服务。');
}

function ldPlayer() {
  const folders = [
    process.env.LDPLAYER_HOME,
    process.env.ADB_PATH && dirname(process.env.ADB_PATH),
    'C:/LDPlayer/LDPlayer14', 'C:/leidian/LDPlayer14', 'C:/leidian/LDPlayer9',
    'D:/LDPlayer/LDPlayer14', 'D:/leidian/LDPlayer9',
  ].filter(Boolean);
  const folder = folders.find(path => existsSync(join(path, 'ldconsole.exe')) && existsSync(join(path, 'adb.exe')));
  if (!folder) throw new Error('未找到雷电。请把 LDPLAYER_HOME 设置为包含 ldconsole.exe 和 adb.exe 的安装目录。');
  return { console: join(folder, 'ldconsole.exe'), adb: join(folder, 'adb.exe') };
}

export function instanceRunning(list, index) {
  const fields = list.split(/\r?\n/).find(line => line.split(',')[0] === String(index))?.split(',');
  if (!fields || fields.length < 10) throw new Error(`雷电中没有编号为 ${index} 的实例。`);
  // Read trailing fields so a comma in the instance title is harmless.
  return fields.at(-6) === '1';
}

async function emulator(player, index, serial) {
  console.log('[2/4] 检查并启动雷电模拟器……');
  if (!instanceRunning(await run(player.console, ['list2']), index)) {
    await run(player.console, ['launch', '--index', String(index)]);
  }
  let reconnected = false;
  await waitUntil(async () => {
    const devices = await run(player.adb, ['devices']);
    const state = devices.split(/\r?\n/).map(line => line.trim().split(/\s+/))
      .find(([id]) => id === serial)?.[1];
    if (state === 'offline' && !reconnected) {
      await run(player.adb, ['reconnect', 'offline']);
      reconnected = true;
    }
    if (state !== 'device') return false;
    try { return await run(player.adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'], 5_000) === '1'; }
    catch { return false; }
  }, '雷电连接超时。请在雷电设置 → 其他设置 → ADB 调试中开启本地连接并重试。', 180_000, 2_000);
}

async function openPage(player, serial) {
  console.log('[3/4] 建立连接并检查页面……');
  await run(player.adb, ['-s', serial, 'reverse', 'tcp:5173', 'tcp:5173']);
  const hasCurl = await run(player.adb, ['-s', serial, 'shell', 'command', '-v', 'curl']).catch(() => '');
  if (hasCurl) {
    const health = await run(player.adb, ['-s', serial, 'shell', 'curl', '--max-time', '10', '--fail', '-sS',
      'http://localhost:5173/api/health']);
    if (JSON.parse(health).ok !== true) throw new Error('模拟器无法连接开发接口，请重新双击启动入口。');
  }
  console.log('[4/4] 在雷电浏览器中打开测试页面……');
  const chrome = await run(player.adb, ['-s', serial, 'shell', 'pm', 'path', 'com.android.chrome']).catch(() => '');
  const result = await run(player.adb, ['-s', serial, 'shell', 'am', 'start', '-W', '-a', 'android.intent.action.VIEW',
    '-d', page, ...(chrome.includes('package:') ? ['-p', 'com.android.chrome'] : [])], 30_000);
  if (!/^Status:\s*ok\s*$/m.test(result)) throw new Error(`浏览器未能打开页面：${result}`);
}

export function lockLaunch(directory = logs) {
  const path = join(directory, 'launch.lock');
  try {
    const descriptor = openSync(path, 'wx');
    try { writeFileSync(descriptor, String(process.pid)); } finally { closeSync(descriptor); }
    return () => rmSync(path, { force: true });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let pid;
    try {
      pid = Number(readFileSync(path, 'utf8'));
      if (!pid && Date.now() - statSync(path).mtimeMs < 5_000) return null;
    } catch (error) {
      if (error.code === 'ENOENT') return lockLaunch(directory);
      throw error;
    }
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return null; }
      catch (error) { if (error.code !== 'ESRCH') return null; }
    }
    rmSync(path, { force: true });
    return lockLaunch(directory);
  }
}

export async function main() {
  process.chdir(root);
  mkdirSync(logs, { recursive: true });
  const unlock = lockLaunch();
  if (!unlock) { console.log('公论手机测试正在启动，请稍候……'); return; }
  try {
    loadEnvironment();
    const index = Number(process.env.LDPLAYER_INDEX || 0);
    if (!Number.isInteger(index) || index < 0) throw new Error('LDPLAYER_INDEX 必须是非负整数。');
    const serial = process.argv[2] || process.env.ANDROID_SERIAL || `emulator-${5554 + index * 2}`;
    const player = ldPlayer();
    await services();
    await emulator(player, index, serial);
    await openPage(player, serial);
    console.log(`\n已打开测试页面：${page}\n以后直接双击“公论手机测试”即可，无法访问时再次双击也会重新连接。`);
  } finally { unlock(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`\n启动失败：${error.message}\n日志目录：${logs}`); process.exitCode = 1; });
}
