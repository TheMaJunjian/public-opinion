import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
import {mkdir,writeFile,unlink} from 'node:fs/promises';
// A test shell can retain NODE_ENV=test; release assets must always use React production.
const env={...process.env,NODE_ENV:'production'};
for(const args of [['run','typecheck'],['--workspace','frontend','run','build']]) {
  const npmCli=process.env.npm_execpath;
  const result=spawnSync(npmCli?process.execPath:'npm',npmCli?[npmCli,...args]:args,{stdio:'inherit',env});
  if(result.error)throw result.error;
  if(result.status!==0)process.exit(result.status??1);
}
const application=await build({entryPoints:{main:'apps/server/src/main.ts','startup-failure':'apps/server/src/startup-failure.ts'},bundle:true,platform:'node',format:'esm',
  external:['express','zod','pg'],outdir:'apps/server/dist',logLevel:'info',metafile:true});
if(Object.keys(application.metafile.inputs).some(path=>path.includes('apps/migrate/')))throw new Error('主程序不能依赖迁移程序');
for(const name of ['migrate-cli','migrate-legacy-cli','retire-legacy-topics-cli','topic-retirement-audit','topic-retirement-view-audit'])
  await unlink(`apps/server/dist/${name}.js`).catch(error=>{if(error.code!=='ENOENT')throw error;});
await writeFile('apps/server/dist/database-version.json',JSON.stringify((await import('../apps/server/src/database-version.ts')).DATABASE_MIGRATIONS));
await build({entryPoints:{
  'migrate-cli':'apps/migrate/src/migrate-cli.ts',
  'startup-cli':'apps/migrate/src/startup-cli.ts',
  'migrate-legacy-cli':'apps/migrate/src/migrate-legacy-cli.ts',
  'verify-legacy-rehearsal-cli':'apps/migrate/src/verify-legacy-rehearsal-cli.ts',
  'verify-current-cli':'apps/migrate/src/verify-current-cli.ts',
  'view-file-cli':'apps/migrate/src/view-file-cli.ts',
  'retire-legacy-topics-cli':'apps/migrate/src/retire-legacy-topics-cli.ts',
  'topic-retirement-audit':'apps/migrate/src/topic-retirement-audit.ts',
  'topic-retirement-view-audit':'apps/migrate/src/topic-retirement-view-audit.ts',
},bundle:true,platform:'node',format:'esm',external:['express','zod','pg'],outdir:'apps/migrate/dist',logLevel:'info'});
await mkdir('frontend/dist/migration',{recursive:true});
await build({entryPoints:['apps/migrate/src/browser-tool.ts'],bundle:true,platform:'browser',format:'esm',outfile:'frontend/dist/migration/tool.js'});
await writeFile('frontend/dist/migration/index.html','<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>公论迁移工具</title><main style="max-width:640px;margin:48px auto;padding:16px;font-family:system-ui"><h1>公论迁移工具</h1><p>迁移在本机完成。原记录会保留，不会自动发送消息。</p><button id="cache">迁移本机待确认记录</button><p><label>转换旧版阅览文件 <input id="archive" type="file" accept=".json"></label></p><p id="result" role="status"></p></main><script type="module" src="./tool.js"></script>');
