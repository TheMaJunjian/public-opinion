import { databaseConfiguration, verifyExistingDatabase } from './image-database.mjs';

try {
  const configuration = databaseConfiguration(process.env);
  const verified = await verifyExistingDatabase(configuration);
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
