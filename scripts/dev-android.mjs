import { main } from './start-android.mjs';

main().catch(error => {
  console.error(`启动失败：${error.message}`);
  process.exitCode = 1;
});
