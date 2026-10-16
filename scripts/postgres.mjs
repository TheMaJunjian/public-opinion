import { spawn } from 'node:child_process';
import { loadEnvFile } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const developmentDatabaseUrl = 'postgresql://gonglun:gonglun_dev@127.0.0.1:54329/gonglun';
const composePath = fileURLToPath(new URL('../deploy/docker-compose.dev.yml', import.meta.url));

export function loadEnvironment() {
  try { loadEnvFile(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function ensureDevelopmentDatabase() {
  const databaseUrl = process.env.DATABASE_URL || developmentDatabaseUrl;
  process.env.DATABASE_URL = databaseUrl;
  if (databaseUrl !== developmentDatabaseUrl) return;
  console.log('Starting local PostgreSQL on 127.0.0.1:54329...');
  await new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '-f', composePath, 'up', '-d', '--wait', 'postgres'], { stdio: 'inherit' });
    child.on('error', () => reject(new Error('Docker is required for the local database. Start Docker, or set DATABASE_URL to an existing PostgreSQL database.')));
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`PostgreSQL startup failed (exit ${code}). Check Docker, or set DATABASE_URL to an existing PostgreSQL database.`)));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  loadEnvironment();
  try { await ensureDevelopmentDatabase(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
