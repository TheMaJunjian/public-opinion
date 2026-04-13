import 'dotenv/config';
import app from './app';
import { prisma } from './lib/prisma';

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

async function main() {
  await prisma.$connect();
  console.log('✅ 数据库连接成功');

  app.listen(PORT, () => {
    console.log(`🚀 公论后端服务已启动，端口: ${PORT}`);
    console.log(`📖 API 文档: http://localhost:${PORT}/api-docs`);
  });
}

main().catch((err) => {
  console.error('❌ 服务启动失败:', err);
  process.exit(1);
});
