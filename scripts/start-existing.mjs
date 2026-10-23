import { databaseConfiguration, verifyExistingDatabase } from './image-database.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';

try {
  const configuration = databaseConfiguration(process.env);
  const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(new URL('../apps/migrate/dist/startup-cli.js',import.meta.url)),
    ...(process.argv.includes('--check')?['--plan']:[])],{env:{...process.env,DATABASE_URL:configuration.url,DATABASE_SCHEMA:configuration.schema},maxBuffer:1024*1024});
  const prepared=JSON.parse(stdout);
  if(process.argv.includes('--check')&&prepared.legacy){console.log('Existing legacy database verified');process.exit(0);}
  if(!process.argv.includes('--check'))configuration.schema=prepared.schema;
  const verified = await verifyExistingDatabase(configuration,undefined,undefined,{allowPending:process.argv.includes('--check')});
  console.log('Existing database verified:', JSON.stringify(verified));
  if (!process.argv.includes('--check')) {
    process.env.DATABASE_URL = configuration.url;
    process.env.DATABASE_SCHEMA = configuration.schema;
    await import('../apps/server/dist/main.js');
  }
} catch (error) {
  console.error('启动已取消：', String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g, '[数据库地址已隐藏]'));
  process.exitCode = 1;
}
