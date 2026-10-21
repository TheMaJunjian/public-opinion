import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, mkdtempSync, renameSync, createReadStream, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve, posix, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { isIP } from 'node:net';
import { verifyExistingDatabase } from './image-database.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const identifier = /^[a-z_][a-z0-9_]{0,62}$/;
const readText = path => existsSync(path) ? readFileSync(path, 'utf8') : null;
const yes = answer => /^(y|yes)$/i.test(answer);
const quoteShell = value => `'${value.replaceAll("'", "'\\''")}'`;

export async function prompt(label, fallback = '') {
  // Release the console after each prompt so OpenSSH can read its own password.
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await terminal.question(`${label} [${fallback}]: `)).trim() || String(fallback); }
  finally { terminal.close(); }
}

export function runCommand(command, args, { cwd = repository, capture = false } = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: capture ? 'utf8' : undefined,
    stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'], windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error?.code === 'ENOENT') throw new Error(`未找到 ${command}，请先安装相应工具。`);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 执行失败（退出码 ${result.status ?? result.signal}）。`);
  return capture ? result.stdout : '';
}

export function connectionLabel(value) {
  if (!value) return '未配置';
  try { const u = new URL(value); return `${u.hostname}:${u.port || 5432}/${decodeURIComponent(u.pathname.slice(1))}`; }
  catch { return '连接配置无法解析'; }
}

export function validateRemote({ host, port, user, deployDir, backupDir }) {
  if (!(isIP(host) || /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host))) throw new Error('VPS 地址须为 IP 或主机名。');
  if (!/^\d{1,5}$/.test(String(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('SSH 端口须为 1–65535。');
  if (!/^[a-z_][a-z0-9_-]*$/i.test(user)) throw new Error('SSH 用户名无效。');
  for (const path of [deployDir, backupDir]) {
    // Keep remote paths safe for server commands and SFTP batch arguments.
    if (!/^\/[a-z0-9_./-]+$/i.test(path) || path.split('/').includes('..')) throw new Error('VPS 目录须为绝对路径，使用字母、数字、下划线、点、斜线或短横线。');
  }
  return { host, port: String(Number(port)), user, deployDir: posix.normalize(deployDir), backupDir: posix.normalize(backupDir) };
}

export function localBackups(directory) {
  const result = [];
  function visit(path) {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name.includes('.partial.')) continue;
      const file = join(path, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith('.dump')) result.push(file);
    }
  }
  visit(directory);
  return result.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs || a.localeCompare(b));
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyBackup(file) {
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error('所选备份文件不存在。');
  const directory = dirname(file), metadataPath = join(directory, 'metadata.txt');
  const single = readText(`${file}.sha256`), manifest = readText(join(directory, 'SHA256SUMS'));
  const records = text => text.trim().split(/\r?\n/).filter(Boolean).map(line => {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line);
    if (!match) throw new Error('SHA256 校验文件格式无效。');
    return { hash: match[1].toLowerCase(), name: match[2] };
  });
  const sums = single !== null ? records(single) : manifest !== null ? records(manifest) : null;
  if (!sums) throw new Error('缺少 SHA256SUMS 或 .dump.sha256；请下载完整备份目录。');
  const matches = single !== null ? sums : sums.filter(row => row.name === basename(file));
  if (matches.length !== 1 || await hashFile(file) !== matches[0].hash) throw new Error('备份 SHA256 校验失败。');
  if (existsSync(metadataPath) && manifest !== null) {
    const meta = records(manifest).filter(row => row.name === 'metadata.txt');
    if (meta.length !== 1 || await hashFile(metadataPath) !== meta[0].hash) throw new Error('备份 metadata.txt 校验失败。');
  }
  return parseEnv(readText(metadataPath) || '');
}

export function updateEnvContents(original, url, schema) {
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const replacements = new Map([['DATABASE_URL', url], ['DATABASE_SCHEMA', schema]]);
  const result = [];
  for (const line of original.split(/\r?\n/)) {
    const key = /^\s*(?:export\s+)?(DATABASE_URL|DATABASE_SCHEMA)\s*=/.exec(line)?.[1];
    if (!key) result.push(line);
    else if (replacements.has(key)) { result.push(`${key}=${replacements.get(key)}`); replacements.delete(key); }
  }
  while (result.at(-1) === '') result.pop();
  for (const [key, value] of replacements) result.push(`${key}=${value}`);
  return `${result.join(newline)}${newline}`;
}

async function selectFile(files, ask, log) {
  if (!files.length) throw new Error('未找到完成的 .dump 备份，请先生成备份或核对目录。');
  files.forEach((file, index) => log(`${index + 1}) ${file}`));
  const answer = await ask('选择备份序号，回车或 0 取消', '0');
  if (answer === '0') return null;
  if (!/^[1-9][0-9]*$/.test(answer) || !Number.isSafeInteger(Number(answer)) || Number(answer) > files.length) throw new Error('备份序号无效。');
  return files[Number(answer) - 1];
}

export async function synchronize({ repoRoot = repository, ask = prompt, run = runCommand, log = console.log, verifyDatabase = verifyExistingDatabase } = {}) {
  const envPath = join(repoRoot, '.env'), original = readText(envPath);
  const values = parseEnv(original || '');
  log(`当前本地 .env 数据库：${connectionLabel(values.DATABASE_URL)}；schema：${values.DATABASE_SCHEMA || 'public'}`);
  if (process.env.DATABASE_URL) log(`当前终端还设置了 DATABASE_URL：${connectionLabel(process.env.DATABASE_URL)}`);
  log('请先用 Ctrl+C 停止本地 npm run dev。恢复将使用新库，原库保留。');
  log('1) 从 VPS 选择已有备份，下载并恢复\n2) 选择已下载的本地备份恢复\n3) 先在 VPS 新建在线备份，再下载并恢复\n0) 退出');
  const action = await ask('选择操作', '0');
  if (action === '0') return { switched: false };
  if (!['1', '2', '3'].includes(action)) throw new Error('操作序号无效。');
  const settingsPath = join(repoRoot, '.env.vps-sync.json');
  const saved = JSON.parse(readText(settingsPath) || '{}');
  const localDir = resolve(repoRoot, await ask('本地备份存放目录', saved.localDir || join(repoRoot, 'deploy/backups')));
  let file;
  if (action === '2') {
    writeFileSync(settingsPath, `${JSON.stringify({ ...saved, localDir }, null, 2)}\n`, { mode: 0o600 });
    file = await selectFile(localBackups(localDir), ask, log);
  } else {
    const host = await ask('VPS 地址', saved.host || '');
    const port = await ask('SSH 端口', saved.port || '22');
    const user = await ask('SSH 用户名', saved.user || 'root');
    const deployDir = await ask('VPS 部署目录', saved.deployDir || '/root/projects/public-opinion/deploy');
    const backupDir = await ask('VPS 备份目录', saved.backupDir || `${deployDir}/backups`);
    const remote = validateRemote({ host, port, user, deployDir, backupDir });
    writeFileSync(settingsPath, `${JSON.stringify({ ...remote, localDir }, null, 2)}\n`, { mode: 0o600 });
    const destination = `${remote.user}@${remote.host.includes(':') ? `[${remote.host}]` : remote.host}`;
    if (action === '3') {
      log('即将在 VPS 运行现有在线备份脚本；请确认它显示的生产数据库，再按提示备份。完成后返回本地选择新备份。');
      run('ssh', ['-t', '-p', remote.port, destination, `bash ${quoteShell(`${remote.deployDir}/manage.sh`)} backup`], { cwd: repoRoot });
    }
    const command = `find ${quoteShell(remote.backupDir)} -type d -name '*.partial.*' -prune -o -type f \\( -name '*.dump' -o -name SHA256SUMS -o -name metadata.txt -o -name '*.dump.sha256' \\) -print0`;
    const listing = run('ssh', ['-p', remote.port, destination, command], { cwd: repoRoot, capture: true });
    const remoteFiles = [...new Set(listing.split('\0').filter(Boolean))];
    for (const path of remoteFiles) {
      if (!path.startsWith(`${remote.backupDir}/`) || !/^\/[a-z0-9_./-]+$/i.test(path) || path.split('/').includes('..')) throw new Error('VPS 返回了备份目录以外或不支持的文件路径。');
    }
    const selected = await selectFile(remoteFiles.filter(path => path.endsWith('.dump') && !path.split('/').some(part => part.includes('.partial.'))).sort().reverse(), ask, log);
    if (!selected) return { switched: false };
    const parent = posix.dirname(selected);
    const sidecars = [`${selected}.sha256`, `${parent}/SHA256SUMS`, `${parent}/metadata.txt`].filter(path => remoteFiles.includes(path));
    if (!sidecars.some(path => path.endsWith('.sha256') || path.endsWith('/SHA256SUMS'))) throw new Error('远程备份缺少校验文件，请核对备份是否完整。');
    mkdirSync(localDir, { recursive: true });
    const partial = mkdtempSync(join(localDir, '.vps-download.partial.'));
    try {
      // One SFTP session avoids scp reconnecting/authenticating once per remote source.
      // Only these known files are fetched, never an entire deployment directory.
      const batchFile = join(partial, 'download.sftp');
      const batch = [...[selected, ...sidecars].map(path => `get "${path}" "${posix.basename(path)}"`), 'bye', ''].join('\n');
      writeFileSync(batchFile, batch, { mode: 0o600, flag: 'wx' });
      log(`正在通过一次 SFTP 连接下载 ${1 + sidecars.length} 个备份文件，请在连接时认证。`);
      try {
        // Must precede -b: OpenSSH uses the first BatchMode value. Allow a console
        // password prompt while still aborting the batch if any get fails.
        run('sftp', ['-oBatchMode=no', '-b', 'download.sftp', '-P', remote.port, destination], { cwd: partial });
      } finally {
        unlinkSync(batchFile);
      }
      await verifyBackup(join(partial, posix.basename(selected)));
      const completed = join(localDir, `${posix.basename(parent)}.download-${randomUUID().slice(0, 8)}`);
      const within = relative(localDir, completed);
      if (!within || within.startsWith('..') || isAbsolute(within)) throw new Error('本地下载目录超出预期范围。');
      renameSync(partial, completed);
      file = join(completed, posix.basename(selected));
      log(`下载及校验成功：${file}`);
    } catch (error) {
      throw new Error(`${error.message}\n未完成下载保留在 ${partial}，不会覆盖已有备份。`);
    }
  }
  if (!file) return { switched: false };
  const metadata = await verifyBackup(file);
  log(`所选备份：${file}`);
  log(`源数据库：${metadata.database || '未记录'}；备份时间 UTC：${metadata.created_at_utc || '未记录'}；源镜像：${metadata.image || '未记录'}`);
  const schema = await ask('备份中的业务 schema', identifier.test(metadata.schema || '') ? metadata.schema : values.DATABASE_SCHEMA || 'public');
  if (!identifier.test(schema)) throw new Error('schema 名称无效。');
  const suggestedName = `gonglun_vps_${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
  const database = await ask('恢复到新的本地数据库名（不能使用已有库）', suggestedName);
  if (!identifier.test(database) || ['postgres', 'template0', 'template1'].includes(database)) throw new Error('新数据库名无效。');
  const context = run('docker', ['context', 'show'], { cwd: repoRoot, capture: true }).trim();
  const endpoint = JSON.parse(run('docker', ['context', 'inspect', context, '--format', '{{json .Endpoints.docker.Host}}'], { cwd: repoRoot, capture: true }));
  if (!/^(npipe|unix):\/\//.test(endpoint)) throw new Error('当前 Docker context 连接到远程地址；请切回本机 Docker Desktop 后重试。');
  // Explicit context/project prevent inherited DOCKER_HOST or COMPOSE_PROJECT_NAME from redirecting restoration.
  const compose = ['--context', context, 'compose', '--project-name', 'gonglun-dev', '-f', join(repoRoot, 'deploy/docker-compose.dev.yml')];
  const docker = (args, capture = false) => run('docker', [...compose, ...args], { cwd: repoRoot, capture });
  log(`只在本地开发容器中恢复：127.0.0.1:54329/${database}；schema：${schema}`);
  docker(['up', '-d', '--wait', 'postgres']);
  const existing = docker(['exec', '-T', 'postgres', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'gonglun', '-d', 'postgres', '-c', `SELECT 1 FROM pg_database WHERE datname = '${database}'`], true).trim();
  if (existing) throw new Error('本地目标库已存在，请重新运行并使用新库名。原库未修改。');
  const containerFile = `/tmp/gonglun-sync-${randomUUID()}.dump`;
  let created = false;
  try {
    docker(['cp', file, `postgres:${containerFile}`]);
    docker(['exec', '-T', 'postgres', 'pg_restore', '--list', containerFile], true);
    docker(['exec', '-T', 'postgres', 'createdb', '-U', 'gonglun', '-O', 'gonglun', '-T', 'template0', '--', database]);
    created = true;
    docker(['exec', '-T', 'postgres', 'pg_restore', '-U', 'gonglun', '-d', database, '--no-owner', '--no-acl', '--exit-on-error', '--single-transaction', containerFile]);
    const url = `postgresql://gonglun:gonglun_dev@127.0.0.1:54329/${database}`;
    const checked = await verifyDatabase({ url, schema, database, rehearsal: false });
    log(`恢复与只读检查通过：${checked.database}；schema：${checked.schema}；用户数：${checked.users}`);
    log(`将本地 .env 从 ${connectionLabel(values.DATABASE_URL)} 切换到 ${connectionLabel(url)}。`);
    if (!yes(await ask('确认切换本地网站？输入 y 确认；回车保留原连接', 'N'))) {
      log(`已恢复到 ${database}，本地 .env 未切换。`);
      return { switched: false, database, file };
    }
    if (readText(envPath) !== original) throw new Error('.env 在操作期间发生变化，已停止切换以保留你的修改。');
    const suffix = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomUUID().slice(0, 8)}`;
    let previous;
    if (original !== null) {
      previous = join(repoRoot, `.env.before-vps-sync-${suffix}`);
      writeFileSync(previous, original, { mode: 0o600, flag: 'wx' });
    }
    const temporary = join(repoRoot, `.env.vps-sync-tmp-${suffix}`);
    writeFileSync(temporary, updateEnvContents(original || readText(join(repoRoot, '.env.example')) || '', url, schema), { mode: 0o600, flag: 'wx' });
    renameSync(temporary, envPath);
    log(`本地数据库已切换到 ${database}。原数据库保留。${previous ? `原配置备份：${previous}` : ''}`);
    log('在当前 PowerShell 中重新运行 npm run dev，再检查本地网站的登录、消息及余额。');
    if (process.env.DATABASE_URL || process.env.DATABASE_SCHEMA) log('直接使用 Node 入口时，请先在 PowerShell 清除旧的 Env:DATABASE_URL 和 Env:DATABASE_SCHEMA；PowerShell 入口会自动清除。');
    return { switched: true, database, schema, file, previous };
  } catch (error) {
    throw new Error(`${error.message}\n${created ? `新建的本地库 ${database} 已保留供检查。` : ''}本地连接未切换，原数据库保留。`);
  } finally {
    try { docker(['exec', '-T', 'postgres', 'rm', '-f', '--', containerFile]); }
    catch { log(`容器临时文件未能清理：${containerFile}`); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) {
    console.log('运行 .\\deploy\\sync-vps-db.ps1 或 node scripts/sync-vps-db.mjs，按提示下载/选择备份、恢复到新的本地开发库，再确认切换 .env。需要 Node.js 24、Docker Desktop 及 OpenSSH 客户端（ssh、sftp）。');
  } else {
    try {
      if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('需要 Node.js 24 或更新版本。');
      await synchronize();
    } catch (error) {
      console.error(String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g, '[数据库连接已隐藏]'));
      process.exitCode = 1;
    }
  }
}
